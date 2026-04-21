import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { IncomingMessage } from "http";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const SESSION_FILE = join(WORKSPACE_DIR, ".sessions.json");

let activeSessions: Map<string, { email: string; createdAt: number }> = new Map();

export function loadSessions() {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
      const now = Date.now();
      const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
      const entries = Object.entries(data)
        .filter(([_, v]: any) => now - (v as any).createdAt < MAX_AGE) as [string, { email: string; createdAt: number }][];
      activeSessions = new Map(entries);
      console.log(`Loaded ${activeSessions.size} active sessions`);
    }
  } catch {
    console.warn("Could not load sessions, starting fresh");
  }
}

function saveSessions() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(activeSessions)));
  } catch {
    console.warn("Could not persist sessions");
  }
}

export function createSession(email: string): string {
  const id = randomBytes(32).toString("hex");
  activeSessions.set(id, { email, createdAt: Date.now() });
  saveSessions();
  return id;
}

export function isValidSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  if (Date.now() - session.createdAt > MAX_AGE) {
    activeSessions.delete(sessionId);
    saveSessions();
    return false;
  }
  return true;
}

export function deleteSession(sessionId: string) {
  activeSessions.delete(sessionId);
  saveSessions();
}

export function clearAllSessions() {
  activeSessions.clear();
  saveSessions();
}

export function getSessionCookie(req: IncomingMessage): string | null {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith("session="));
  return match?.substring("session=".length) || null;
}
