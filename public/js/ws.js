import { state } from "./state.js";
import { dom } from "./dom.js";
import { loadNotesTree } from "./notes/browser.js";
import {
  taskHandleCreated, taskHandleStarted, taskHandleOutput, taskHandleFinished, renderTasks, loadTasks,
} from "./tasks.js";
import { feedTTSAudioChunk, stopTTSPlayback } from "./voice/audio.js";
import {
  beginKaraokeSentence, recalibrateKaraokeSentence, scheduleTurnComplete,
} from "./voice/karaoke.js";
import { setInterimTranscript, addToolCard, renderToolDebug } from "./voice/transcript.js";
import { renderVoiceQuote } from "./voice/quotes.js";
import {
  renderPlanOutline, updatePlanOutlineActive, clearPlanOutline,
} from "./voice/plan-outline.js";
import { showGestureAck } from "./voice/gestures.js";

// Single WebSocket message dispatcher. Every message that arrives on the WS flows
// through here — we classify it (binary = TTS audio; JSON = control/event) and hand
// off to the right module. Keeps the terminal module free of voice/task concerns.

export function dispatchWsMessage(event) {
  // Binary frame = TTS audio (PCM16 24kHz from server)
  if (event.data instanceof ArrayBuffer) {
    feedTTSAudioChunk(new Uint8Array(event.data));
    return;
  }

  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  switch (msg.type) {
    // --- PTY / terminal ---
    case "output":
      if (state.terminal) state.terminal.write(msg.data);
      return;
    case "reconnect":
      if (state.terminal) state.terminal.writeln("\x1b[2m[Reconnected to existing session]\x1b[0m");
      return;
    case "idle-killed":
      if (state.terminal) state.terminal.writeln("\r\n\x1b[33m[Session stopped after 30 min idle \u2014 type anything to restart]\x1b[0m");
      return;
    case "respawned":
      if (state.terminal) state.terminal.writeln("\x1b[32m[Session restarted]\x1b[0m");
      return;
    case "exit":
      if (state.terminal) state.terminal.writeln("\r\n\x1b[33m[Claude Code exited]\x1b[0m");
      return;
    case "tree-changed":
      loadNotesTree();
      return;

    // --- Task events ---
    case "task:created":   taskHandleCreated(msg.data); return;
    case "task:started":   taskHandleStarted(msg.data); return;
    case "task:output":    taskHandleOutput(msg.data); return;
    case "task:completed":
    case "task:failed":
    case "task:cancelled": taskHandleFinished(msg.data); return;
    case "task:updated": {
      if (msg.data) {
        const idx = state.tasksList.findIndex(t => t.id === msg.data.id);
        if (idx >= 0) state.tasksList[idx] = msg.data;
        renderTasks();
      }
      return;
    }
    case "auto-execute:changed": {
      state.taskAutoExecute = !!msg.data?.enabled;
      const toggle = document.getElementById("auto-execute-toggle");
      if (toggle) toggle.checked = state.taskAutoExecute;
      return;
    }
    case "cron:created":
    case "cron:updated":
    case "cron:deleted":
      loadTasks();
      return;

    // --- Voice events ---
    case "voice:quote":       if (msg.data) renderVoiceQuote(msg.data); return;
    case "voice:action-ack":  showGestureAck(msg.action, msg.ok, msg.detail); return;
    case "voice:plan":        if (msg.data) renderPlanOutline(msg.data); return;
    case "voice:plan-progress": if (msg.data) updatePlanOutlineActive(msg.data.activeIdx); return;
    case "voice:plan-clear":  clearPlanOutline(); return;

    case "voice:ready":
      dom.voiceStatus.textContent = "Listening...";
      return;
    case "voice:clear-audio":
      stopTTSPlayback();
      return;

    case "voice:stt": {
      // Barge-in heuristic: only interrupt playback when the STT text is substantial.
      // One or two-character deltas are usually echo leakage / noise and would
      // otherwise nuke the audio context, breaking karaoke for subsequent sentences.
      const sttText = (msg.text || "").trim();
      const meaningfulText = sttText.length >= 6 && sttText.split(/\s+/).length >= 2;
      const hasBufferedAudio = state.voiceIsPlaying
        || (state.voiceAudioCtx && state.ttsNextStartTime > state.voiceAudioCtx.currentTime + 0.05);
      if (meaningfulText && hasBufferedAudio) {
        stopTTSPlayback();
        state.ws.send(JSON.stringify({ type: "voice:interrupt" }));
      }
      // Show interim transcript as soon as deltas arrive — prevents "did my mic work?"
      // anxiety during the LLM/TTS latency window.
      if (msg.text && msg.text.trim()) {
        const last = dom.transcriptEl.lastElementChild;
        if (last && last.dataset.role === "agent" && last.dataset.done !== "true") {
          last.dataset.done = "true";
        }
        setInterimTranscript("user", msg.text);
      }
      if (msg.is_final && msg.text) {
        // Promote interim bubble to final
        const userBubble = dom.transcriptEl.lastElementChild;
        if (userBubble && userBubble.dataset.role === "user") {
          userBubble.classList.remove("transcript-interim");
          userBubble.dataset.done = "true";
        }
        dom.voiceStatus.textContent = "Thinking...";
      }
      return;
    }
    case "voice:planning":   dom.voiceStatus.textContent = "Researching..."; return;
    case "voice:llm-start":  dom.voiceStatus.textContent = "Speaking..."; return;
    case "voice:speak":
      dom.voiceStatus.textContent = "Speaking...";
      beginKaraokeSentence(msg.id, msg.text, msg.estimatedDurationMs, msg.sectionIdx);
      return;
    case "voice:speak-end":
      recalibrateKaraokeSentence(msg.id, msg.actualDurationMs);
      return;
    case "voice:llm-tool":
      dom.voiceStatus.textContent = `Tool: ${msg.name}(...)`;
      addToolCard(msg.name, msg.args, "running...");
      return;
    case "voice:llm-tool-result": {
      const cards = dom.transcriptEl.querySelectorAll(".tool-card");
      const lastCard = cards[cards.length - 1];
      if (lastCard) {
        const header = lastCard.querySelector(".tool-card-header");
        const body = lastCard.querySelector(".tool-card-body");
        if (header && msg.debug?.duration) header.querySelector(".tool-duration").textContent = `${msg.debug.duration}ms`;
        if (body && msg.debug) { renderToolDebug(body, msg.debug); body.classList.add("open"); }
      }
      return;
    }
    case "voice:tts-done":
      // Server has finished STREAMING, but OpenAI TTS streams faster than
      // realtime — there's still audio queued to play. Delay the "turn complete"
      // effects (flush dim words, status reset) until audio actually ends on the
      // client, so karaoke can finish naturally and we don't flash everything lit.
      scheduleTurnComplete();
      return;
    case "voice:ended":
      state.voiceSessionActive = false;
      dom.intelVoice.classList.remove("session-active");
      if (dom.transcriptEl.children.length > 0) dom.intelVoice.classList.add("session-ended");
      clearPlanOutline();
      return;
    case "voice:error":
      dom.voiceStatus.textContent = `Error: ${msg.error}`;
      return;
  }
}
