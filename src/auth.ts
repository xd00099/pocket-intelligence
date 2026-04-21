import express, { Router } from "express";
import { IncomingMessage } from "http";
import { WebSocket } from "ws";
import { createSession, isValidSession, deleteSession, getSessionCookie } from "./lib/session.js";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAIL, INTERNAL_API_TOKEN } from "./config.js";
import { getConnectedWs, setConnectedWs } from "./core/connection.js";

// Authenticated = valid session cookie OR internal API token header.
// The internal token lets Claude Code (running on the server) call task/cron APIs
// without a session — it sets X-Internal-Token on every request.
export function isAuthenticated(req: express.Request | IncomingMessage): boolean {
  const tokenHeader = (req as any).headers?.["x-internal-token"];
  if (tokenHeader === INTERNAL_API_TOKEN) return true;
  const sessionId = getSessionCookie(req as any);
  return !!(sessionId && isValidSession(sessionId));
}

// Resolve the request's public-facing origin, honoring the `x-forwarded-proto` header
// from a reverse proxy (Railway, nginx) so OAuth redirects use https:// in production.
export function getOrigin(req: express.Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Express middleware that 401s when the caller isn't authenticated. Used for task/cron
// routes that accept either session cookies or the internal token.
export const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!isAuthenticated(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
};

// Shorter idiom: require a session cookie specifically (rejects internal tokens).
// Used for endpoints that are UI-only, not for server-to-server Claude Code calls.
export function requireSessionCookie(req: express.Request, res: express.Response): boolean {
  const sessionId = getSessionCookie(req as any);
  if (!sessionId || !isValidSession(sessionId)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- OAuth routes ---
// onLogoutKillPty: called when a user logs out — the server tears down the Claude Code
// pty so it doesn't hog RAM waiting for the next login. Passed in to avoid importing
// pty directly (keeps circular deps out of auth.ts).
export function buildAuthRouter(onLogoutKillPty: () => void): Router {
  const r = Router();

  // Kick off Google OAuth consent.
  r.get("/auth/google", (req, res) => {
    const redirectUri = `${getOrigin(req)}/auth/callback`;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      access_type: "online",
      prompt: "select_account",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // Handle OAuth callback: exchange code for ID token, verify email, set session cookie.
  r.get("/auth/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) { res.status(400).send("Missing authorization code"); return; }

    try {
      const redirectUri = `${getOrigin(req)}/auth/callback`;

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID!,
          client_secret: GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        console.error("Token exchange failed:", await tokenRes.text());
        res.status(401).send("Authentication failed");
        return;
      }

      const tokens = await tokenRes.json() as { id_token: string };
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()
      );
      const email = payload.email as string;
      console.log(`OAuth login attempt: ${email}`);

      if (email.toLowerCase() !== ALLOWED_EMAIL!.toLowerCase()) {
        console.warn(`Rejected login from unauthorized email: ${email}`);
        res.status(403).send(`
          <html><body style="background:#1a1a2e;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
              <h1>Access Denied</h1>
              <p style="color:#888">This sandbox is not configured for ${email}</p>
              <a href="/auth/google" style="color:#6c63ff">Try a different account</a>
            </div>
          </body></html>
        `);
        return;
      }

      const sessionId = createSession(email);
      res.cookie("session", sessionId, {
        httpOnly: true,
        secure: req.headers["x-forwarded-proto"] === "https",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      console.log(`Authenticated: ${email}`);
      res.redirect("/");
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).send("Authentication error");
    }
  });

  // Logout: invalidate session, tear down pty, close any connected WebSocket.
  r.get("/auth/logout", (req, res) => {
    const sessionId = getSessionCookie(req as any);
    if (sessionId && isValidSession(sessionId)) {
      deleteSession(sessionId);
      onLogoutKillPty();
      const ws = getConnectedWs();
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      setConnectedWs(null);
    }
    res.clearCookie("session");
    res.redirect("/");
  });

  // Frontend polls this to decide login vs terminal display.
  r.get("/api/auth/check", (req, res) => {
    const sessionId = getSessionCookie(req as any);
    if (sessionId && isValidSession(sessionId)) res.json({ authenticated: true });
    else res.status(401).json({ authenticated: false });
  });

  return r;
}
