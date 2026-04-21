import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { NOTES_DIR } from "../config.js";
import { safePath } from "../lib/notes-helpers.js";

// Stopwords dropped from keyword extraction. Deliberately small — we want to keep
// domain terms. The grep is case-insensitive, so casing of keywords doesn't matter.
const STOPWORDS = new Set([
  "the","a","an","and","or","but","so","of","to","for","in","on","at","by","with","from",
  "is","are","was","were","be","been","being","am","do","does","did","done","have","has","had",
  "can","could","would","should","will","shall","may","might","must",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their",
  "this","that","these","those","what","which","who","whom","whose","where","when","why","how",
  "if","then","else","than","as","about","over","me","my",
  "go","going","tell","say","said","explain","describe","walk","give","get","got","talk","show","want",
  "please","okay","ok","yes","no","yeah","nope","just","really","very","also","too",
  "some","any","all","every","each","few","more","most","other","same",
]);

export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    keywords.push(t);
    if (keywords.length >= 8) break;
  }
  return keywords;
}

export interface NoteFile { path: string; content: string; score: number; }
export interface NoteContext { files: NoteFile[]; keywords: string[]; }

// Grep-based retrieval: find notes matching the user's keywords, score by hit density
// with a small penalty on index/readme files, read top 3 with content truncated.
// Pure Node — no LLM call. Returns {} if NOTES_DIR is absent or empty.
export function gatherNoteContext(userText: string): NoteContext {
  const keywords = extractKeywords(userText);
  if (!existsSync(NOTES_DIR) || keywords.length === 0) return { files: [], keywords };

  const fileHits = new Map<string, number>();
  for (const kw of keywords) {
    const safe = kw.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");
    try {
      const out = execSync(
        `grep -r -i -l --include='*.md' -- '${safe}' . 2>/dev/null || true`,
        { cwd: NOTES_DIR, encoding: "utf8", timeout: 5000 }
      ).trim();
      if (!out) continue;
      for (const line of out.split("\n")) {
        if (!line) continue;
        const p = line.replace(/^\.\//, "");
        fileHits.set(p, (fileHits.get(p) || 0) + 1);
      }
    } catch { /* grep failure = empty result for this keyword */ }
  }
  if (fileHits.size === 0) return { files: [], keywords };

  // Score: keyword hits + bonus for wiki/concepts paths, penalty for index/readme/log files.
  const scored: NoteFile[] = [];
  for (const [path, hits] of fileHits) {
    let score = hits;
    const base = path.split("/").pop()?.toLowerCase() || "";
    if (base === "index.md" || base === "readme.md" || base === "log.md" || base === "toc.md") score -= 2;
    if (/\bwiki\//.test(path) || /\bconcepts\//.test(path)) score += 1;

    const fp = safePath(path);
    if (!fp || !existsSync(fp)) continue;
    let content = "";
    try {
      content = readFileSync(fp, "utf8").slice(0, 3000);
    } catch { continue; }
    scored.push({ path, content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { files: scored.slice(0, 3), keywords };
}

// Format note context as a planner-friendly string. Empty string if nothing was found.
export function formatNoteContext(ctx: NoteContext): string {
  if (ctx.files.length === 0) return "";
  const parts = [`Keywords extracted: ${ctx.keywords.join(", ")}`];
  for (const f of ctx.files) {
    parts.push(`\n### ${f.path}\n${f.content}`);
  }
  return parts.join("\n");
}
