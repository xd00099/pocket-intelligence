import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname } from "path";

export const PORT = parseInt(process.env.PORT || "3000", 10);
export const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
export const NOTES_REPO = process.env.NOTES_REPO;
export const NOTES_DIR = join(WORKSPACE_DIR, "notes");
export const NOTES_SYNC_INTERVAL = parseInt(process.env.NOTES_SYNC_INTERVAL || "300", 10) * 1000;
export const CLIPPINGS_DIR = join(NOTES_DIR, "_clippings");
export const PREVIEW_CACHE = join(WORKSPACE_DIR, ".preview-cache");

// --- Voice pipeline ---
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const VOICE_LLM_MODEL = process.env.VOICE_LLM_MODEL || "gpt-5.4";
export const VOICE_STT_MODEL = process.env.VOICE_STT_MODEL || "gpt-4o-transcribe";
// semantic_vad eagerness: "low" | "medium" | "high" | "auto". Lower = more pause
// tolerance (waits longer before deciding the user is done speaking).
export const VOICE_STT_EAGERNESS = (process.env.VOICE_STT_EAGERNESS || "low") as "low" | "medium" | "high" | "auto";
export const VOICE_TTS_MODEL = process.env.VOICE_TTS_MODEL || "gpt-4o-mini-tts";
export const VOICE_TTS_VOICE = process.env.VOICE_TTS_VOICE || "coral";
export const VOICE_TTS_SPEED = parseFloat(process.env.VOICE_TTS_SPEED || "1.15");

// --- Anthropic (used by /api/chat only) ---
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- OAuth / session ---
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL;
export const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");

// Random token for internal API calls from Claude Code back to the server
export const INTERNAL_API_TOKEN = randomBytes(24).toString("hex");

// --- Paths resolved from this module's location ---
const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);
export const PUBLIC_DIR = join(__dirname, "..", "public");

// --- Claude Code binary path resolution ---
function resolveClaudeBin(): string {
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    console.warn("Could not resolve 'claude' path, using bare name");
    return "claude";
  }
}
export const CLAUDE_BIN = resolveClaudeBin();

// --- Startup validation + directory creation ---
export function validateAndInitialize() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !ALLOWED_EMAIL) {
    console.error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ALLOWED_EMAIL are required");
    process.exit(1);
  }
  for (const dir of [WORKSPACE_DIR, process.env.HOME || "/workspace/.home"]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  }
  console.log(`Using claude binary: ${CLAUDE_BIN}`);
}
