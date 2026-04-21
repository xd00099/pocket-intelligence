import express from "express";
import { createServer } from "http";
import { PORT, PUBLIC_DIR, NOTES_REPO, ALLOWED_EMAIL, WORKSPACE_DIR, validateAndInitialize } from "./config.js";
import { loadSessions } from "./lib/session.js";
import { initNotesSync } from "./lib/notes-helpers.js";
import { ensureClaudeConfig, killPty } from "./pty.js";
import { initTaskAndCron } from "./task-events.js";
import { buildAuthRouter } from "./auth.js";
import { buildNotesRouter } from "./routes/notes.js";
import { buildChatRouter } from "./routes/chat.js";
import { buildTasksRouter } from "./routes/tasks.js";
import { attachWebSocket, startFsWatcher, registerShutdown } from "./ws-handler.js";

// --- Boot sequence ---
// 1) Validate env + create workspace dirs
// 2) Load persisted sessions from disk
// 3) Pre-configure Claude Code (skip onboarding) — must run before TaskQueue worker
//    or pty can spawn
// 4) Start notes git sync + init task queue + cron scheduler
// 5) Build Express app with routes + static files
// 6) Attach WebSocket handler, fs watcher, shutdown hooks
// 7) Listen

validateAndInitialize();
loadSessions();
ensureClaudeConfig();
initNotesSync();
initTaskAndCron();

const app = express();
app.set("trust proxy", true);
const server = createServer(app);

// Health check (unauthenticated)
app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

// Routes
app.use(buildAuthRouter(killPty));
app.use(buildNotesRouter());
app.use(buildChatRouter());
app.use(buildTasksRouter());

// Static files — serves the frontend. The page does its own auth check via
// /api/auth/check so unauthenticated users land on the login overlay.
app.use(express.static(PUBLIC_DIR));

// WebSocket + file watcher + shutdown hooks
attachWebSocket(server);
startFsWatcher();
registerShutdown(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pocket Intelligence running on port ${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
  console.log(`Allowed user: ${ALLOWED_EMAIL}`);
  if (NOTES_REPO) console.log(`Notes repo: ${NOTES_REPO}`);
});
