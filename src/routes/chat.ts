import express, { Router } from "express";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { NOTES_DIR, ANTHROPIC_API_KEY } from "../config.js";
import { safePath } from "../lib/notes-helpers.js";
import { requireSessionCookie } from "../auth.js";

// Lightweight text chat over the knowledge base. Used by the intel panel's chat tab
// for quick Q&A separate from the voice pipeline. Calls Anthropic directly; falls back
// to 503 if ANTHROPIC_API_KEY isn't set.
export function buildChatRouter(): Router {
  const r = Router();

  r.post("/api/chat", express.json(), async (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!ANTHROPIC_API_KEY) { res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" }); return; }

    const { message, context } = req.body;
    if (!message) { res.status(400).json({ error: "No message" }); return; }

    // Inject context: current open note + any search query results
    let kbContext = "";
    if (context?.notePath) {
      const fp = safePath(context.notePath);
      if (fp && existsSync(fp)) {
        kbContext += `\n\nCurrent note (${context.notePath}):\n${readFileSync(fp, "utf8").slice(0, 4000)}`;
      }
    }
    if (context?.searchQuery) {
      const safeQ = context.searchQuery.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");
      try {
        const out = execSync(`grep -r -i -n --include='*.md' '${safeQ}' . 2>/dev/null | head -30 || true`, { cwd: NOTES_DIR, encoding: "utf8", timeout: 5000 }).trim();
        if (out) kbContext += `\n\nSearch results for "${context.searchQuery}":\n${out.slice(0, 3000)}`;
      } catch {}
    }

    try {
      const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: `You are a concise knowledge assistant. The user has an Obsidian vault knowledge base. Answer based on the provided context. If no context is relevant, say so briefly. Use markdown formatting.${kbContext}`,
          messages: [{ role: "user", content: message }],
        }),
      });

      if (!apiRes.ok) {
        const err = await apiRes.text();
        console.error("Anthropic API error:", err);
        res.status(502).json({ error: "AI request failed" });
        return;
      }

      const data = await apiRes.json() as { content: Array<{ text: string }> };
      res.json({ response: data.content?.[0]?.text || "No response" });
    } catch (err: any) {
      console.error("Chat error:", err.message);
      res.status(500).json({ error: "Chat request failed" });
    }
  });

  return r;
}
