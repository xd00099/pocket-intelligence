import express, { Router } from "express";
import multer from "multer";
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, rmSync, mkdirSync, renameSync } from "fs";
import { join, dirname, basename, relative } from "path";
import { execSync } from "child_process";
import { createHmac } from "crypto";
import { NOTES_DIR, NOTES_REPO, CLIPPINGS_DIR, PREVIEW_CACHE } from "../config.js";
import { safePath, pullNotes, pushNotes } from "../lib/notes-helpers.js";
import { requireSessionCookie } from "../auth.js";
import { getPty, resetIdleTimer } from "../pty.js";

// --- File upload (multer) ---
// Uploaded files land in _clippings/ for ingest. Filename is sanitized to prevent
// path traversal; timestamp prefix avoids collisions.
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    mkdirSync(CLIPPINGS_DIR, { recursive: true });
    cb(null, CLIPPINGS_DIR);
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim();
    const final = existsSync(join(CLIPPINGS_DIR, safe)) ? `${Date.now()}-${safe}` : safe;
    cb(null, final);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const blocked = [".exe", ".sh", ".bat", ".cmd", ".pipelined", ".dll", ".so"];
    const ext = "." + (file.originalname.split(".").pop()?.toLowerCase() || "");
    cb(null, !blocked.includes(ext));
  },
});

export function buildNotesRouter(): Router {
  const r = Router();

  // --- Git sync endpoints ---

  r.post("/api/notes/pull", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!NOTES_REPO) { res.status(404).json({ error: "Notes sync not configured" }); return; }
    const pulled = pullNotes();
    if (pulled) res.json({ ok: true, message: "Notes pulled from GitHub" });
    else res.status(500).json({ error: "Pull failed" });
  });

  r.post("/api/notes/push", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!NOTES_REPO) { res.status(404).json({ error: "Notes sync not configured" }); return; }
    const pulled = pullNotes();
    const pushed = pushNotes();
    if (pushed) res.json({ ok: true, message: "Notes pushed to GitHub" });
    else if (pulled) res.json({ ok: true, message: "No changes to push (already up to date)" });
    else res.status(500).json({ error: "Push failed" });
  });

  // Revert a single file to its last committed state. Tracked files → git checkout;
  // untracked → unlink or rm -rf.
  r.post("/api/notes/revert-file", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: filePath } = req.body;
    if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }
    const fp = safePath(filePath);
    if (!fp) { res.status(400).json({ error: "Invalid path" }); return; }
    try {
      if (!/^[\w\s\-./]+$/.test(filePath)) { res.status(400).json({ error: "Invalid characters in path" }); return; }
      console.log("Revert request for:", filePath);
      if (!existsSync(fp)) { res.status(404).json({ error: "File not found" }); return; }
      let isTracked = false;
      try {
        execSync("git ls-files --error-unmatch " + JSON.stringify(filePath), { cwd: NOTES_DIR, stdio: "pipe" });
        isTracked = true;
      } catch { isTracked = false; }
      if (isTracked) {
        execSync("git checkout HEAD -- " + JSON.stringify(filePath), { cwd: NOTES_DIR });
      } else {
        const isDir = statSync(fp).isDirectory();
        if (isDir) rmSync(fp, { recursive: true, force: true });
        else unlinkSync(fp);
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Returns whether there are uncommitted changes in the notes git repo.
  r.get("/api/notes/status", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!NOTES_REPO || !existsSync(join(NOTES_DIR, ".git"))) { res.json({ configured: false }); return; }
    try {
      const status = execSync("git status --porcelain", { cwd: NOTES_DIR, encoding: "utf8" });
      const changedFiles = status.trim().split("\n").filter(Boolean);
      res.json({ configured: true, hasChanges: changedFiles.length > 0, changedCount: changedFiles.length });
    } catch {
      res.json({ configured: true, hasChanges: false, changedCount: 0 });
    }
  });

  // Git diff for all tracked + untracked changes. Capped at 10 MB per call. Used by
  // the edit mode diff review UI.
  r.get("/api/notes/diff", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!existsSync(join(NOTES_DIR, ".git"))) { res.json({ files: [], diff: "" }); return; }
    try {
      const status = execSync("git status --porcelain -z", { cwd: NOTES_DIR, encoding: "utf8" });
      // -z uses NUL separators and doesn't quote paths — much more reliable
      const files = status.split("\0").filter(Boolean).map(entry => {
        const st = entry.slice(0, 2);
        const p = entry.slice(3);
        return { status: st.trim(), path: p };
      }).filter(f => f.path);
      console.log("Diff: files=", files.map(f => `[${f.status}] ${f.path}`));
      let diff = "";
      try { diff = execSync("git diff HEAD", { cwd: NOTES_DIR, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }); } catch {
        // HEAD might not exist — fall back to unstaged + staged
        try { diff += execSync("git diff", { cwd: NOTES_DIR, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }); } catch {}
        try { diff += execSync("git diff --cached", { cwd: NOTES_DIR, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }); } catch {}
      }
      const untracked = files.filter(f => f.status === "??");
      for (const f of untracked.slice(0, 20)) {
        const fp = safePath(f.path);
        if (fp && existsSync(fp)) {
          try {
            const content = readFileSync(fp, "utf8");
            const lines = content.split("\n");
            diff += `\ndiff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map(l => `+${l}`).join("\n") + "\n";
          } catch {}
        }
      }
      console.log("Diff: diff length=", diff.length, "files=", files.length);
      res.json({ files, diff });
    } catch (err: any) {
      console.error("Diff endpoint error:", err);
      res.json({ files: [], diff: "", error: err.message });
    }
  });

  // --- Tree + file endpoints ---

  r.get("/api/notes/tree", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!existsSync(NOTES_DIR)) { res.json({ tree: [] }); return; }

    function buildTree(dir: string, relPath: string, depth = 0): any[] {
      if (depth > 8) return [];
      try {
        const entries = readdirSync(dir).filter(n => !n.startsWith(".") && n !== "node_modules");
        const items = entries.map(name => {
          const full = join(dir, name);
          const ep = relPath ? `${relPath}/${name}` : name;
          try {
            const s = statSync(full);
            const isDir = s.isDirectory();
            return isDir
              ? { name, path: ep, type: "dir" as const, children: buildTree(full, ep, depth + 1) }
              : { name, path: ep, type: "file" as const, size: s.size, modified: s.mtimeMs };
          } catch { return null; }
        }).filter(Boolean) as any[];
        items.sort((a, b) => {
          if (a.type === "dir" && b.type !== "dir") return -1;
          if (a.type !== "dir" && b.type === "dir") return 1;
          return a.name.localeCompare(b.name);
        });
        return items;
      } catch { return []; }
    }
    res.json({ tree: buildTree(NOTES_DIR, "") });
  });

  // Read a note, extract backlinks + outgoing wiki-links, and list sibling raw/ resources.
  r.get("/api/notes/file", (req, res) => {
    if (!requireSessionCookie(req, res)) return;

    let userPath = (req.query.path as string || "").replace(/^\.\//, "");
    let filePath = safePath(userPath);
    if (filePath && !existsSync(filePath) && !userPath.endsWith(".md")) {
      const withMd = safePath(userPath + ".md");
      if (withMd && existsSync(withMd)) { filePath = withMd; userPath += ".md"; }
    }
    if (!filePath || !existsSync(filePath)) { res.status(404).json({ error: "File not found" }); return; }

    const content = readFileSync(filePath, "utf8");
    const fstat = statSync(filePath);
    const baseName = userPath.split("/").pop()?.replace(/\.md$/, "") || "";
    let backlinks: string[] = [];
    try {
      const r = execSync(`grep -r -l --include='*.md' -F '[[${baseName.replace(/'/g, "'\\''")}' . 2>/dev/null || true`, { cwd: NOTES_DIR, encoding: "utf8", timeout: 5000 }).trim();
      backlinks = r.split("\n").filter(Boolean).map(f => f.replace(/^\.\//, "")).filter(f => f !== userPath);
    } catch {}

    const outgoingLinks: string[] = [];
    const wlRegex = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
    let wlm;
    while ((wlm = wlRegex.exec(content)) !== null) {
      const t = wlm[1].trim();
      if (!outgoingLinks.includes(t)) outgoingLinks.push(t);
    }

    // Find raw resources for wiki articles (sibling raw/ folder)
    let rawFiles: Array<{ name: string; path: string; size: number }> = [];
    const wikiIdx = userPath.indexOf("/wiki/");
    if (wikiIdx !== -1) {
      const topicDir = userPath.substring(0, wikiIdx);
      const rawDirPath = safePath(topicDir + "/raw");
      if (rawDirPath && existsSync(rawDirPath) && statSync(rawDirPath).isDirectory()) {
        try {
          rawFiles = readdirSync(rawDirPath)
            .filter(n => !n.startsWith("."))
            .map(name => {
              const full = join(rawDirPath, name);
              try { return { name, path: `${topicDir}/raw/${name}`, size: statSync(full).size }; }
              catch { return null; }
            })
            .filter(Boolean) as Array<{ name: string; path: string; size: number }>;
        } catch {}
      }
    }

    res.json({ path: userPath, content, size: fstat.size, modified: fstat.mtimeMs, backlinks, outgoingLinks, rawFiles });
  });

  r.get("/api/notes/search", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const query = (req.query.q as string || "").trim();
    if (!query || !existsSync(NOTES_DIR)) { res.json({ results: [] }); return; }
    const safeQ = query.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");

    try {
      const out = execSync(`grep -r -i -n --include='*.md' '${safeQ}' . 2>/dev/null | head -100 || true`, { cwd: NOTES_DIR, encoding: "utf8", timeout: 10000 }).trim();
      if (!out) { res.json({ results: [] }); return; }

      const map = new Map<string, { path: string; matches: { line: number; text: string }[] }>();
      for (const line of out.split("\n")) {
        const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
        if (m) {
          const [, p, ln, txt] = m;
          if (!map.has(p)) map.set(p, { path: p, matches: [] });
          const entry = map.get(p)!;
          if (entry.matches.length < 3) entry.matches.push({ line: parseInt(ln), text: txt.trim() });
        }
      }
      res.json({ results: Array.from(map.values()).slice(0, 20), query });
    } catch (err: any) {
      res.json({ results: [], error: err.message });
    }
  });

  // Serve images / static assets referenced from notes. Falls back to filename-only
  // search because Obsidian wiki-links reference by name, not path.
  r.get("/api/notes/asset", (req, res) => {
    if (!requireSessionCookie(req, res)) { return; }
    const userPath = (req.query.path as string || "").replace(/^\.\//, "");
    let filePath = safePath(userPath);
    if ((!filePath || !existsSync(filePath)) && userPath && existsSync(NOTES_DIR)) {
      const filename = userPath.split("/").pop() || "";
      if (filename) {
        try {
          const found = execSync(
            `find . -name '${filename.replace(/'/g, "'\\''")}' -not -path '*/\\.*' -type f | head -1`,
            { cwd: NOTES_DIR, encoding: "utf8", timeout: 3000 }
          ).trim();
          if (found) filePath = safePath(found.replace(/^\.\//, ""));
        } catch {}
      }
    }
    if (!filePath || !existsSync(filePath)) { res.status(404).send("Not found"); return; }
    res.sendFile(filePath);
  });

  // Convert office files (PPTX, DOCX, XLSX) to PDF for in-browser preview using
  // LibreOffice. Output is cached on disk keyed by an HMAC of the path.
  r.get("/api/notes/preview", (req, res) => {
    if (!requireSessionCookie(req, res)) { return; }
    const userPath = (req.query.path as string || "").replace(/^\.\//, "");
    const filePath = safePath(userPath);
    if (!filePath || !existsSync(filePath)) { res.status(404).send("Not found"); return; }

    mkdirSync(PREVIEW_CACHE, { recursive: true });
    const hash = createHmac("sha256", "preview").update(userPath).digest("hex").slice(0, 12);
    const cachedPdf = join(PREVIEW_CACHE, `${hash}.pdf`);

    if (existsSync(cachedPdf)) {
      res.setHeader("Content-Type", "application/pdf");
      res.sendFile(cachedPdf);
      return;
    }

    try {
      const tmpDir = join(PREVIEW_CACHE, `tmp-${hash}`);
      mkdirSync(tmpDir, { recursive: true });
      execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${filePath}"`, {
        timeout: 60000,
        env: { ...process.env, HOME: process.env.HOME || "/tmp" } as Record<string, string>,
      });
      const outputs = readdirSync(tmpDir).filter(f => f.endsWith(".pdf"));
      if (outputs.length > 0) {
        execSync(`mv "${join(tmpDir, outputs[0])}" "${cachedPdf}"`);
        execSync(`rm -rf "${tmpDir}"`);
        res.setHeader("Content-Type", "application/pdf");
        res.sendFile(cachedPdf);
        return;
      }
      execSync(`rm -rf "${tmpDir}"`);
      res.status(500).send("Conversion produced no output");
    } catch (err: any) {
      console.error("Preview conversion failed:", err.message);
      res.status(503).send("Preview conversion not available. LibreOffice may not be installed.");
    }
  });

  // Knowledge graph — all notes and their wiki-link connections.
  r.get("/api/notes/graph", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!existsSync(NOTES_DIR)) { res.json({ nodes: [], edges: [] }); return; }

    const nodes: Array<{ id: number; path: string; name: string; dir: string }> = [];
    const pathToId = new Map<string, number>();
    const nameToId = new Map<string, number>();

    function walkDir(dir: string, relPath: string) {
      try {
        for (const name of readdirSync(dir).filter(n => !n.startsWith(".") && n !== "node_modules")) {
          const full = join(dir, name);
          const ep = relPath ? `${relPath}/${name}` : name;
          try {
            if (statSync(full).isDirectory()) { walkDir(full, ep); }
            else if (name.endsWith(".md")) {
              const id = nodes.length;
              const topDir = ep.split("/")[0] || "";
              nodes.push({ id, path: ep, name: name.replace(/\.md$/, ""), dir: topDir });
              pathToId.set(ep, id);
              nameToId.set(name.replace(/\.md$/, "").toLowerCase(), id);
            }
          } catch {}
        }
      } catch {}
    }
    walkDir(NOTES_DIR, "");

    const edgeSet = new Set<string>();
    const edges: Array<{ source: number; target: number }> = [];

    for (const node of nodes) {
      try {
        const content = readFileSync(join(NOTES_DIR, node.path), "utf8");
        const re = /\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const target = m[1].trim();
          let tid = pathToId.get(target) ?? pathToId.get(target + ".md") ?? nameToId.get(target.toLowerCase());
          if (tid !== undefined && tid !== node.id) {
            const key = `${Math.min(node.id, tid)}-${Math.max(node.id, tid)}`;
            if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ source: node.id, target: tid }); }
          }
        }
      } catch {}
    }

    res.json({ nodes, edges });
  });

  // Vault-wide stats: note + word counts, breakdown by top-level folder.
  r.get("/api/notes/stats", (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    if (!existsSync(NOTES_DIR)) { res.json({ totalNotes: 0, totalWords: 0, topics: [] }); return; }

    let totalNotes = 0, totalWords = 0;
    const topics = new Map<string, { notes: number; words: number }>();

    function walk(dir: string, relPath: string) {
      try {
        for (const name of readdirSync(dir).filter(n => !n.startsWith(".") && n !== "node_modules")) {
          const full = join(dir, name);
          try {
            if (statSync(full).isDirectory()) { walk(full, relPath ? `${relPath}/${name}` : name); }
            else if (name.endsWith(".md")) {
              totalNotes++;
              const content = readFileSync(full, "utf8");
              const words = content.split(/\s+/).filter(Boolean).length;
              totalWords += words;
              const topDir = (relPath || "root").split("/")[0];
              const t = topics.get(topDir) || { notes: 0, words: 0 };
              t.notes++; t.words += words;
              topics.set(topDir, t);
            }
          } catch {}
        }
      } catch {}
    }
    walk(NOTES_DIR, "");

    res.json({
      totalNotes, totalWords,
      topics: Array.from(topics.entries()).map(([name, data]) => ({ name, ...data })).sort((a, b) => b.notes - a.notes)
    });
  });

  // Quick capture — append to inbox/YYYY-MM-DD.md. Creates file if missing.
  r.post("/api/notes/capture", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { text, title } = req.body;
    if (!text || !text.trim()) { res.status(400).json({ error: "Empty note" }); return; }

    const inboxDir = join(NOTES_DIR, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const logFile = join(inboxDir, `${today}.md`);

    if (existsSync(logFile)) {
      appendFileSync(logFile, `\n---\n\n### ${time}${title ? " — " + title : ""}\n\n${text.trim()}\n`);
    } else {
      writeFileSync(logFile, `# Captures — ${today}\n\n### ${time}${title ? " — " + title : ""}\n\n${text.trim()}\n`);
    }

    res.json({ ok: true, path: `inbox/${today}.md` });
  });

  // Save voice conversation transcript as a note in conversations/.
  r.post("/api/notes/save-conversation", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { transcript } = req.body;
    if (!transcript || !transcript.trim()) { res.status(400).json({ error: "Empty transcript" }); return; }

    const convDir = join(NOTES_DIR, "conversations");
    mkdirSync(convDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const filePath = join(convDir, `${ts}.md`);
    const header = `---\ntype: voice-conversation\ndate: ${new Date().toISOString()}\n---\n\n# Voice Conversation — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}\n\n`;
    writeFileSync(filePath, header + transcript.trim() + "\n");

    res.json({ ok: true, path: `conversations/${ts}.md` });
  });

  // Write file content (used by edit mode).
  r.post("/api/notes/save-file", express.json({ limit: "5mb" }), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: userPath, content } = req.body;
    if (!userPath || typeof content !== "string") { res.status(400).json({ error: "Missing path or content" }); return; }
    const filePath = safePath(userPath);
    if (!filePath) { res.status(400).json({ error: "Invalid path" }); return; }
    try {
      writeFileSync(filePath, content, "utf8");
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- File operations: rename/move, new file, new folder, delete, duplicate ---
  // Each op validates via safePath so traversal outside NOTES_DIR is blocked. No git
  // awareness — users commit via the Diff review UI; fs changes get picked up by
  // the file watcher and broadcast as tree-changed, which refreshes the UI.

  // Rename or move. Same endpoint because both reduce to `fs.renameSync(src, dst)`.
  r.post("/api/notes/rename", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { from, to } = req.body;
    if (!from || !to) { res.status(400).json({ error: "Missing from or to" }); return; }
    const src = safePath(from);
    const dst = safePath(to);
    if (!src || !dst) { res.status(400).json({ error: "Invalid path" }); return; }
    if (!existsSync(src)) { res.status(404).json({ error: "Source not found" }); return; }
    if (existsSync(dst)) { res.status(409).json({ error: "Destination already exists" }); return; }
    // Disallow moving a folder into itself or a descendant
    if (src !== dst && (dst + "/").startsWith(src + "/")) {
      res.status(400).json({ error: "Cannot move into itself" }); return;
    }
    try {
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new empty markdown file. Initial content defaults to "# <Name>\n\n".
  r.post("/api/notes/new-file", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: userPath, content } = req.body;
    if (!userPath) { res.status(400).json({ error: "Missing path" }); return; }
    const fp = safePath(userPath);
    if (!fp) { res.status(400).json({ error: "Invalid path" }); return; }
    if (existsSync(fp)) { res.status(409).json({ error: "File already exists" }); return; }
    try {
      mkdirSync(dirname(fp), { recursive: true });
      const initial = typeof content === "string" ? content : `# ${basename(fp).replace(/\.md$/, "")}\n\n`;
      writeFileSync(fp, initial);
      res.json({ ok: true, path: userPath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  r.post("/api/notes/new-folder", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: userPath } = req.body;
    if (!userPath) { res.status(400).json({ error: "Missing path" }); return; }
    const fp = safePath(userPath);
    if (!fp) { res.status(400).json({ error: "Invalid path" }); return; }
    if (existsSync(fp)) { res.status(409).json({ error: "Folder already exists" }); return; }
    try {
      mkdirSync(fp, { recursive: true });
      res.json({ ok: true, path: userPath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a file or folder (recursive). Git will show it as removed until committed
  // via the Diff review UI.
  r.delete("/api/notes/delete", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: userPath } = req.body;
    if (!userPath) { res.status(400).json({ error: "Missing path" }); return; }
    const fp = safePath(userPath);
    if (!fp) { res.status(400).json({ error: "Invalid path" }); return; }
    if (!existsSync(fp)) { res.status(404).json({ error: "Not found" }); return; }
    try {
      const isDir = statSync(fp).isDirectory();
      if (isDir) rmSync(fp, { recursive: true, force: true });
      else unlinkSync(fp);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Duplicate a file (folders not supported — no good semantics for large trees).
  // Picks a unique name like "original (copy).md" or "original (copy 2).md".
  r.post("/api/notes/duplicate", express.json(), (req, res) => {
    if (!requireSessionCookie(req, res)) return;
    const { path: userPath } = req.body;
    if (!userPath) { res.status(400).json({ error: "Missing path" }); return; }
    const src = safePath(userPath);
    if (!src) { res.status(400).json({ error: "Invalid path" }); return; }
    if (!existsSync(src) || !statSync(src).isFile()) {
      res.status(400).json({ error: "Can only duplicate files" }); return;
    }
    const dir = dirname(src);
    const base = basename(src);
    const dotIdx = base.lastIndexOf(".");
    const ext = dotIdx > 0 ? base.slice(dotIdx) : "";
    const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    let newName = `${stem} (copy)${ext}`;
    let i = 2;
    while (existsSync(join(dir, newName))) {
      newName = `${stem} (copy ${i})${ext}`;
      i++;
    }
    const dst = join(dir, newName);
    try {
      writeFileSync(dst, readFileSync(src));
      res.json({ ok: true, path: relative(NOTES_DIR, dst) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // File upload — saves to _clippings/, optionally triggers `/ingest` in the pty.
  r.post("/api/notes/upload", (req, res, next) => {
    if (!requireSessionCookie(req, res)) return;
    next();
  }, upload.array("files", 20), (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) { res.status(400).json({ error: "No files uploaded" }); return; }
    const uploaded = files.map(f => ({ name: f.filename, originalName: f.originalname, size: f.size, path: `_clippings/${f.filename}` }));
    console.log(`Uploaded ${files.length} file(s) to _clippings/: ${uploaded.map(f => f.name).join(", ")}`);

    const autoIngest = req.query.ingest !== "false";
    const pty = getPty();
    if (autoIngest && pty) {
      setTimeout(() => {
        const p = getPty();
        if (p) {
          p.write("/ingest\r");
          resetIdleTimer();
          console.log("Sent /ingest command to Claude Code PTY");
        }
      }, 500);
    }
    res.json({ ok: true, files: uploaded, ingestTriggered: autoIngest && !!pty });
  });

  return r;
}
