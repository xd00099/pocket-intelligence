import { WebSocket } from "ws";
import { OPENAI_API_KEY, VOICE_STT_MODEL, VOICE_STT_EAGERNESS } from "../config.js";
import { sendJson } from "../core/connection.js";
import { state } from "./state.js";

// Callback fired when STT produces a final transcript. Set by the orchestrator to
// inject a new turn or queue the utterance if the LLM is busy. Decouples STT from
// session.ts to avoid a circular import.
let onFinalTranscript: (text: string) => void = () => {};
export function setSttFinalHandler(fn: (text: string) => void) { onFinalTranscript = fn; }

// Open a WebSocket to OpenAI's Realtime transcription endpoint. Uses semantic VAD
// (classifier over the partial transcript) rather than silence-only to detect turn
// boundaries more reliably in noisy/thinking environments.
export function openSTT() {
  if (!OPENAI_API_KEY) return;
  const url = "wss://api.openai.com/v1/realtime?intent=transcription";
  const ws = new WebSocket(url, {
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });
  state.sttSocket = ws;

  ws.on("open", () => {
    console.log("[Voice STT] Connected");
    // eagerness:"low" is the most patient setting — the classifier waits for a
    // clear completed-thought signal before ending the turn. This gives the user
    // room to pause mid-sentence ("um, let me think... X") without being cut off.
    // "medium" was too aggressive in real use. Override via VOICE_STT_EAGERNESS
    // if a different trade-off is needed.
    ws.send(JSON.stringify({
      type: "transcription_session.update",
      session: {
        input_audio_format: "pcm16",
        input_audio_transcription: { model: VOICE_STT_MODEL },
        turn_detection: { type: "semantic_vad", eagerness: VOICE_STT_EAGERNESS },
        input_audio_noise_reduction: { type: "near_field" },
      },
    }));
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "conversation.item.input_audio_transcription.delta") {
        const text = ev.delta || "";
        state.sttTranscriptAccum += text;
        sendJson({ type: "voice:stt", text: state.sttTranscriptAccum, is_final: false });
      } else if (ev.type === "conversation.item.input_audio_transcription.completed") {
        const text = ev.transcript || state.sttTranscriptAccum;
        state.sttTranscriptAccum = "";
        sendJson({ type: "voice:stt", text, is_final: true });
        if (text.trim() && state.active) {
          if (state.isLLMGenerating) {
            state.pendingUserUtterances.push(text.trim());
            console.log(`[Voice STT] Queued utterance (turn busy): "${text.trim().slice(0, 60)}"`);
          } else {
            onFinalTranscript(text.trim());
          }
        }
      } else if (ev.type === "error") {
        console.error("[Voice STT] Error:", ev.error);
      }
    } catch {}
  });

  ws.on("error", (err: Error) => console.error("[Voice STT] WS error:", err.message));
  ws.on("close", () => { console.log("[Voice STT] Disconnected"); state.sttSocket = null; });
}

// Forward a base64 audio chunk to the STT socket. Silently drops if the socket isn't
// open yet — STT-without-voice is fine during the brief window between voice:start
// and the transcription_session.update ack.
export function sendAudioChunk(b64: string) {
  const socket = state.sttSocket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
  }
}

export function closeSTT() {
  if (state.sttSocket) {
    try { state.sttSocket.close(); } catch {}
    state.sttSocket = null;
  }
  state.sttTranscriptAccum = "";
}
