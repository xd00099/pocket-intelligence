import { OPENAI_API_KEY, VOICE_TTS_MODEL } from "../config.js";
import { sendBinary } from "../core/connection.js";
import { state, nextFillerIdx } from "./state.js";

// --- TTS: OpenAI Speech API (streaming PCM) ---
// Streams PCM16 24kHz audio to the client WS. Returns the actual audio duration in
// ms (derived from byte count), which the client uses to recalibrate karaoke timing
// via voice:speak-end. Respects state.genId so interrupts abort mid-stream.
export async function speakSentence(text: string, genId?: number): Promise<number> {
  if (!OPENAI_API_KEY || !state.active) return 0;
  const myGenId = genId ?? state.genId;
  let totalBytes = 0;
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VOICE_TTS_MODEL,
        voice: state.currentVoice,
        input: text,
        response_format: "pcm",
        speed: state.currentSpeed,
      }),
    });
    if (!res.ok || !res.body) { console.error("[Voice TTS] Error:", res.status); return 0; }
    const reader = (res.body as any).getReader();
    while (true) {
      if (state.genId !== myGenId) { reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      if (state.active && state.genId === myGenId) {
        sendBinary(Buffer.from(value));
        totalBytes += value.length;
      }
    }
  } catch (err: any) {
    if (err.name !== "AbortError") console.error("[Voice TTS] Error:", err.message);
  }
  // PCM16 24kHz mono = 48000 bytes/sec
  return (totalBytes / 48000) * 1000;
}

// --- TTS serialization queue ---
// speakSentence streams PCM bytes to the WS as it reads from the TTS API. Two
// concurrent calls would interleave bytes and corrupt playback, so we serialize all
// TTS work through a promise chain. Reset on interrupt to drop queued work.
let ttsChain: Promise<void> = Promise.resolve();

export function queueTTS(fn: () => Promise<unknown>): Promise<void> {
  const next = ttsChain.then(() => fn().then(() => undefined, () => undefined));
  ttsChain = next;
  return next;
}

export function resetTTSQueue() {
  ttsChain = Promise.resolve();
}

// --- Filler phrases ---
// Rotating set of short acknowledgements played before tool calls so the user hears
// something natural while research/action tools run. No caching for v1 — TTS TTFB
// (~200–400 ms) is the cost of brevity.
export const FILLER_PHRASES = [
  "One moment.",
  "Let me check.",
  "Looking that up.",
  "On it.",
  "Just a sec.",
];
export function nextFiller(): string {
  return FILLER_PHRASES[nextFillerIdx() % FILLER_PHRASES.length];
}

// Rough spoken-duration estimate used to schedule per-word highlights on the client.
// OpenAI TTS at speed 1.0 runs roughly 12 chars/sec for English conversational prose;
// we scale linearly with speed. Good enough for karaoke — if the estimate drifts,
// the server sends the authoritative actual duration on voice:speak-end.
export function estimateSpeechDurationMs(text: string, speed: number): number {
  const charsPerSec = 12 * Math.max(speed, 0.25);
  const baseMs = (text.length / charsPerSec) * 1000;
  // Minimum floor so very short utterances don't get zero duration scheduling.
  return Math.max(400, Math.round(baseMs));
}
