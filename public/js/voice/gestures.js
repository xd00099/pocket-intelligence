import { state } from "../state.js";
import { stopTTSPlayback } from "./audio.js";

// Voice gesture buttons (deeper / save). "deeper" restarts the turn so we stop
// local TTS immediately for snappiness (server spins up a new turn). "save" is
// passive — it appends to voice-saved.md and fires a toast.
export function initGestures() {
  document.querySelectorAll(".voice-gesture").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!state.voiceSessionActive || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      const action = btn.dataset.action;
      if (!action) return;
      if (action === "deeper") {
        stopTTSPlayback();
        state.ws.send(JSON.stringify({ type: "voice:interrupt" }));
      }
      state.ws.send(JSON.stringify({ type: "voice:action", action }));
      btn.classList.add("voice-gesture-fired");
      setTimeout(() => btn.classList.remove("voice-gesture-fired"), 260);
    });
  });
}

// Ephemeral toast shown on save acknowledgement (not a permanent bubble, minimal UI noise).
export function showGestureAck(action, ok, detail) {
  const el = document.getElementById("voice-gesture-toast");
  if (!el) return;
  const label = action === "save"
    ? (ok ? "Saved to voice-saved.md" : `Couldn't save${detail ? ": " + detail : ""}`)
    : (ok ? `${action} ok` : `${action} failed`);
  el.textContent = label;
  el.classList.toggle("voice-gesture-toast-ok", !!ok);
  el.classList.toggle("voice-gesture-toast-err", !ok);
  el.classList.add("visible");
  if (state.gestureAckTimer) clearTimeout(state.gestureAckTimer);
  state.gestureAckTimer = setTimeout(() => el.classList.remove("visible"), 2200);
}
