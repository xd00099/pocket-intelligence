import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join, resolve, relative } from "path";
import { execSync } from "child_process";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
export const NOTES_DIR = join(WORKSPACE_DIR, "notes");
const NOTES_REPO = process.env.NOTES_REPO;
const NOTES_SYNC_INTERVAL = parseInt(process.env.NOTES_SYNC_INTERVAL || "300", 10) * 1000;

// Path safety — prevent traversal outside NOTES_DIR
export function safePath(userPath: string): string | null {
  const resolved = resolve(NOTES_DIR, userPath || ".");
  if (!resolved.startsWith(NOTES_DIR)) return null;
  return resolved;
}

// Generate a text tree of the notes directory (tree characters, 2 levels deep) for
// the planner prompt. Returns "" if the dir is missing or errors out.
export function generateNotesTree(dir: string, prefix = "", depth = 0): string {
  if (depth > 2 || !existsSync(dir)) return "";
  try {
    const names = readdirSync(dir).filter(n => !n.startsWith(".") && n !== "node_modules");
    const entries = names.map(name => {
      try { return { name, isDir: statSync(join(dir, name)).isDirectory() }; }
      catch { return null; }
    }).filter(Boolean) as Array<{ name: string; isDir: boolean }>;
    entries.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    let tree = "";
    for (let i = 0; i < entries.length; i++) {
      const { name, isDir } = entries[i];
      const fullPath = join(dir, name);
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      try {
        if (isDir) {
          const childCount = readdirSync(fullPath).filter(n => !n.startsWith(".")).length;
          tree += `${prefix}${connector}${name}/ (${childCount} items)\n`;
          if (depth < 2) {
            tree += generateNotesTree(fullPath, prefix + childPrefix, depth + 1);
          }
        } else if (depth < 2) {
          tree += `${prefix}${connector}${name}\n`;
        }
      } catch {}
    }
    return tree;
  } catch {
    return "";
  }
}

export function pullNotes(): boolean {
  if (!NOTES_REPO) return false;
  try {
    if (existsSync(join(NOTES_DIR, ".git"))) {
      execSync("git pull --rebase --autostash", { cwd: NOTES_DIR, stdio: "inherit" });
    } else {
      console.log(`Cloning notes from ${NOTES_REPO}...`);
      execSync(`git clone ${NOTES_REPO} ${NOTES_DIR}`, { stdio: "inherit" });
    }
    return true;
  } catch (err) {
    console.error("Notes pull failed:", err);
    return false;
  }
}

export function pushNotes(): boolean {
  if (!NOTES_REPO || !existsSync(join(NOTES_DIR, ".git"))) return false;
  try {
    const status = execSync("git status --porcelain", { cwd: NOTES_DIR, encoding: "utf8" });
    if (!status.trim()) return false;
    execSync("git add -A", { cwd: NOTES_DIR, stdio: "inherit" });
    execSync('git commit -m "Update from Claude Sandbox"', { cwd: NOTES_DIR, stdio: "inherit" });
    execSync("git push", { cwd: NOTES_DIR, stdio: "inherit" });
    console.log("Notes pushed to GitHub");
    return true;
  } catch (err) {
    console.error("Notes push failed:", err);
    return false;
  }
}

// Build file tree with depth limit
export function buildTree(dir: string, relBase: string = "", depth: number = 0): any[] {
  if (depth > 8) return [];
  try {
    const entries = readdirSync(dir);
    const items: any[] = [];
    const dirs: any[] = [];
    const files: any[] = [];

    const statCache = new Map<string, any>();
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      try { statCache.set(name, statSync(full)); } catch { continue; }
    }

    const sorted = entries
      .filter(n => !n.startsWith(".") && statCache.has(n))
      .sort((a, b) => {
        const aIsDir = statCache.get(a)!.isDirectory();
        const bIsDir = statCache.get(b)!.isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b, undefined, { sensitivity: "base" });
      });

    for (const name of sorted) {
      const full = join(dir, name);
      const relPath = relBase ? `${relBase}/${name}` : name;
      const st = statCache.get(name)!;
      if (st.isDirectory()) {
        items.push({ type: "dir", name, path: relPath, children: buildTree(full, relPath, depth + 1) });
      } else {
        items.push({ type: "file", name, path: relPath, size: st.size });
      }
    }
    return items;
  } catch { return []; }
}

// Initialize notes sync
export function initNotesSync() {
  if (NOTES_REPO) {
    pullNotes();
    setInterval(() => pullNotes(), NOTES_SYNC_INTERVAL);
    console.log(`Notes sync enabled (auto-pull every ${NOTES_SYNC_INTERVAL / 1000}s): ${NOTES_REPO}`);
  }
}
