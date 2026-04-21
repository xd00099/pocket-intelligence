import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { spawn as ptySpawn, IPty } from "node-pty";
import { WORKSPACE_DIR, NOTES_DIR, NOTES_REPO, CLAUDE_BIN, PORT, INTERNAL_API_TOKEN } from "./config.js";
import { sendJson, getConnectedWs } from "./core/connection.js";

// --- Persistent pty session (single user) ---
// The server keeps one Claude Code pty alive per user. On reconnect, the client
// reattaches; on idle timeout we kill it to free memory; on logout we tear it down.

let persistentPty: IPty | null = null;
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const activePtys = new Set<IPty>();

export function getPty(): IPty | null { return persistentPty; }
export function getActivePtys(): Set<IPty> { return activePtys; }

// (Re)start the 30 min idle timer. If it fires the pty is killed; the next input
// reconnects by respawning.
export function resetIdleTimer() {
  if (idleTimeout) clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    if (persistentPty) {
      console.log("Idle timeout — killing Claude Code to save memory");
      persistentPty.kill();
      persistentPty = null;
      sendJson({ type: "idle-killed" });
    }
  }, IDLE_TIMEOUT_MS);
}

export function killPty() {
  if (idleTimeout) { clearTimeout(idleTimeout); idleTimeout = null; }
  if (persistentPty) {
    console.log("Killing Claude Code session");
    activePtys.delete(persistentPty);
    persistentPty.kill();
    persistentPty = null;
  }
}

// True if Claude Code has a prior session we can `--continue` into.
function hasPreviousSession(): boolean {
  const claudeDir = join(process.env.HOME || "/workspace/.home", ".claude", "projects");
  try {
    if (!existsSync(claudeDir)) return false;
    const result = execSync(`find ${claudeDir} -name "*.jsonl" -type f | head -1`, { encoding: "utf8" });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// Write Claude Code's user + project settings to skip first-run prompts (theme, API
// key acceptance, folder trust, security notes) before we spawn the pty. Idempotent.
export function ensureClaudeConfig() {
  const home = process.env.HOME || "/workspace/.home";
  const claudeDir = join(home, ".claude");
  const cwd = NOTES_REPO && existsSync(NOTES_DIR) ? NOTES_DIR : WORKSPACE_DIR;
  const projectClaudeDir = join(cwd, ".claude");

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  if (!existsSync(projectClaudeDir)) mkdirSync(projectClaudeDir, { recursive: true });

  // ~/.claude.json — THE key file that stores onboarding state + API key acceptance.
  // Skips theme selection, API key prompt, security notes, folder trust.
  const stateFile = join(home, ".claude.json");
  const existingState = existsSync(stateFile)
    ? (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; } })()
    : {};
  if (!existingState.hasCompletedOnboarding) {
    const apiKey = process.env.ANTHROPIC_API_KEY || "";
    const keySuffix = apiKey.length > 20 ? apiKey.slice(-20) : apiKey;
    const merged = {
      ...existingState,
      numStartups: (existingState.numStartups || 0) + 1,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.97",
      firstStartTime: existingState.firstStartTime || new Date().toISOString(),
      customApiKeyResponses: {
        approved: keySuffix ? [keySuffix] : [],
        rejected: []
      },
    };
    writeFileSync(stateFile, JSON.stringify(merged, null, 2));
    console.log("Updated ~/.claude.json — onboarding complete + API key approved");
  }

  // ~/.claude/settings.json — permissions to auto-approve tools
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          "Bash(*)", "Read", "Edit", "Write", "Glob", "Grep",
          "WebFetch", "WebSearch", "Agent", "NotebookEdit"
        ],
        deny: []
      },
      skipAutoPermissionPrompt: true
    }, null, 2));
    console.log("Created Claude Code user settings");
  }

  // Project-level local settings: trust this folder
  const localSettingsPath = join(projectClaudeDir, "settings.local.json");
  if (!existsSync(localSettingsPath)) {
    writeFileSync(localSettingsPath, JSON.stringify({
      permissions: {
        allow: [
          "Bash(*)", "Read", "Edit", "Write", "Glob", "Grep",
          "WebFetch", "WebSearch", "Agent", "NotebookEdit"
        ],
        deny: []
      },
      isTrusted: true
    }, null, 2));
    console.log("Created Claude Code project settings");
  }
}

// Fallback for any interactive prompts that ensureClaudeConfig didn't cover.
// Watches pty output for known prompt phrases and sends the answer. One-shot per
// prompt; disposes itself once we see the main Claude prompt or after 20 s.
function autoAnswerPrompts(pty: IPty): void {
  let buffer = "";
  let disposed = false;
  const answered = { apiKey: false, trust: false, security: false };

  function done() {
    if (!disposed) { disposed = true; buffer = ""; disposable.dispose(); console.log("Auto-onboarding complete"); }
  }

  const disposable = pty.onData((data: string) => {
    if (disposed) return;
    buffer += data;

    if (!answered.apiKey && buffer.includes("Do you want to use this API key")) {
      answered.apiKey = true;
      buffer = "";
      setTimeout(() => { if (!disposed) pty.write("1\r"); }, 300);
      return;
    }
    if (!answered.trust && buffer.includes("Yes, I trust this folder")) {
      answered.trust = true;
      buffer = "";
      setTimeout(() => { if (!disposed) pty.write("1\r"); }, 300);
      return;
    }
    if (!answered.security && buffer.includes("Press Enter to continue")) {
      answered.security = true;
      buffer = "";
      setTimeout(() => { if (!disposed) pty.write("\r"); }, 300);
      return;
    }
    if (buffer.includes("? for shortcuts") || buffer.includes("What can I help")) {
      done();
      return;
    }
    if (buffer.length > 2000) buffer = buffer.slice(-500);
  });
  setTimeout(() => { if (!disposed) { disposed = true; disposable.dispose(); } }, 20000);
}

// Spawn a fresh Claude Code pty. Sets up data forwarding to the WS client and exit
// handling. Uses `--continue` if we have a prior session on disk.
export function spawnPty(): IPty {
  ensureClaudeConfig();
  const shell = process.env.SHELL || "/bin/zsh";
  const cwd = NOTES_REPO && existsSync(NOTES_DIR) ? NOTES_DIR : WORKSPACE_DIR;
  const args = [CLAUDE_BIN, "--enable-auto-mode"];
  const isResume = hasPreviousSession();
  if (isResume) {
    args.push("--continue");
    console.log("Resuming previous Claude Code session");
  } else {
    console.log("No previous session found, starting fresh");
  }
  const claudeArgs = args.join(" ");
  const pty = ptySpawn(shell, ["-l", "-c", claudeArgs], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HOME: process.env.HOME || "/workspace/.home",
      PI_INTERNAL_TOKEN: INTERNAL_API_TOKEN,
      PI_API_PORT: String(PORT),
    } as Record<string, string>,
  });

  if (!isResume) autoAnswerPrompts(pty);

  pty.onData((data: string) => {
    sendJson({ type: "output", data });
  });

  pty.onExit(({ exitCode, signal }) => {
    console.log(`Claude Code exited (code=${exitCode}, signal=${signal})`);
    activePtys.delete(pty);
    persistentPty = null;
    const ws = getConnectedWs();
    if (ws) sendJson({ type: "exit", exitCode, signal });
  });

  activePtys.add(pty);
  persistentPty = pty;
  return pty;
}

// Write raw input bytes to the pty (e.g. keystrokes from the browser terminal).
// If the pty has been killed by idle timeout, respawn and warn the caller.
export function writeToPty(data: string): void {
  resetIdleTimer();
  if (!persistentPty) {
    try {
      spawnPty();
      console.log("Respawned Claude Code after idle timeout");
      sendJson({ type: "respawned" });
    } catch (err) {
      console.error("Failed to respawn pty:", err);
      sendJson({ type: "error", message: "Failed to respawn Claude Code" });
      return;
    }
  }
  persistentPty?.write(data);
}

export function resizePty(cols: number, rows: number): void {
  persistentPty?.resize(cols, rows);
}
