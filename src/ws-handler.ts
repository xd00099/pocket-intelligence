import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { existsSync, watch, readdirSync } from "fs";
import { Server } from "http";
import { execSync } from "child_process";
import { join } from "path";
import { NOTES_DIR, NOTES_REPO, PREVIEW_CACHE } from "./config.js";
import { isValidSession, getSessionCookie } from "./lib/session.js";
import { getConnectedWs, setConnectedWs, sendJson, broadcast } from "./core/connection.js";
import { pullNotes } from "./lib/notes-helpers.js";
import { spawnPty, getPty, resetIdleTimer, writeToPty, resizePty, getActivePtys } from "./pty.js";
import { sendAudioChunk } from "./voice/stt.js";
import { startVoiceSession, stopVoiceSession, interruptVoice, handleVoiceAction } from "./voice/session.js";
import * as CronScheduler from "./lib/cron-scheduler.js";
import * as TaskQueue from "./lib/task-queue.js";
import * as WorkerPty from "./lib/worker-pty.js";

// Wire up the WebSocket server onto the passed HTTP server. Handles connection
// upgrade, authenticates via session cookie, spawns/reattaches the pty, and
// dispatches messages to the pty or voice pipeline.
export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const sessionId = getSessionCookie(request);
    if (!sessionId || !isValidSession(sessionId)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    console.log("Client connected");

    // Pull latest notes on connect
    if (NOTES_REPO) pullNotes();

    // Single user — disconnect previous client if any.
    const existing = getConnectedWs();
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.send(JSON.stringify({ type: "taken", message: "Session taken by another connection" }));
      existing.close();
    }
    setConnectedWs(ws);

    // Reuse existing pty or spawn a new one
    if (!getPty()) {
      try {
        spawnPty();
        console.log("Spawned new Claude Code session");
      } catch (err) {
        console.error("Failed to spawn pty:", err);
        ws.send(JSON.stringify({ type: "error", message: "Failed to spawn Claude Code" }));
        ws.close();
        return;
      }
    } else {
      console.log("Reattaching to existing Claude Code session");
      ws.send(JSON.stringify({ type: "reconnect" }));
      resizePty(80, 24);
    }

    resetIdleTimer();

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      // Binary frame = mic audio (PCM16 from browser) → forward to STT
      if (isBinary) {
        sendAudioChunk(raw.toString("base64"));
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "input":
            writeToPty(msg.data);
            break;
          case "resize":
            if (msg.cols && msg.rows) resizePty(msg.cols, msg.rows);
            break;
          case "ping":
            break;
          // Voice pipeline messages
          case "voice:start":
            startVoiceSession(msg);
            break;
          case "voice:stop":
            stopVoiceSession();
            break;
          case "voice:interrupt":
            interruptVoice();
            break;
          case "voice:action":
            handleVoiceAction(String(msg.action || ""), msg);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected (pty stays alive)");
      if (getConnectedWs() === ws) setConnectedWs(null);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      if (getConnectedWs() === ws) setConnectedWs(null);
    });
  });
}

// Watch the notes directory for file changes and push tree-changed events to the
// client so the tree view and task list stay fresh. Debounced 500 ms to avoid
// flooding during bulk operations.
export function startFsWatcher() {
  if (!existsSync(NOTES_DIR)) return;
  let fsWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  const notifyTreeChanged = () => broadcast("tree-changed");
  try {
    watch(NOTES_DIR, { recursive: true }, (_event, filename) => {
      if (!filename || filename.startsWith(".git") || filename.startsWith(".")) return;
      if (fsWatchDebounce) clearTimeout(fsWatchDebounce);
      fsWatchDebounce = setTimeout(notifyTreeChanged, 500);
    });
    console.log("File watcher active on notes directory");
  } catch (err) {
    console.warn("fs.watch failed, falling back to polling:", err);
    setInterval(notifyTreeChanged, 10000);
  }
}

// Graceful shutdown: stop cron, cancel running worker task, flush queue to disk,
// kill ptys, and clean up preview tmp dirs. Called on SIGTERM/SIGINT.
export function registerShutdown(server: Server) {
  function shutdown() {
    console.log("Shutting down...");
    CronScheduler.stopAll();
    const cancelledId = WorkerPty.cancel();
    if (cancelledId) {
      TaskQueue.updateTask(cancelledId, { state: "failed", completedAt: Date.now(), error: "Server shutting down" });
    }
    TaskQueue.flushSave();
    for (const pty of getActivePtys()) {
      pty.kill();
    }
    try {
      if (existsSync(PREVIEW_CACHE)) {
        for (const f of readdirSync(PREVIEW_CACHE)) {
          if (f.startsWith("tmp-")) {
            try { execSync(`rm -rf "${join(PREVIEW_CACHE, f)}"`); } catch {}
          }
        }
      }
    } catch {}
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
