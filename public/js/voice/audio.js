import { state } from "../state.js";
import { cancelKaraoke } from "./karaoke.js";

// TTS audio playback — byte-aligned buffering + gapless scheduled playback.
// Server sends raw PCM16 24kHz bytes. We accumulate 2-byte aligned chunks, convert
// to Float32, and schedule each buffer to start exactly when the previous one ends
// using AudioContext.currentTime as the clock. Output time is tracked in
// state.ttsNextStartTime so karaoke can align word highlights to audio playback.

// Track all scheduled BufferSources so we can stop them on interrupt WITHOUT
// recreating the AudioContext. Recreating breaks mobile: AudioContext requires a
// user gesture to unlock on iOS/Android, and a context created mid-session (outside
// the click handler) stays permanently suspended — so TTS goes silent after the
// first barge-in.
const scheduledSources = new Set();

export function feedTTSAudioChunk(bytes) {
  if (!state.voiceAudioCtx || state.voiceAudioCtx.state === "closed") return;
  // Mobile safety: context may auto-suspend (tab backgrounded, audio session
  // interrupted by a phone call). Opportunistic resume — no-op if already running.
  if (state.voiceAudioCtx.state === "suspended") {
    state.voiceAudioCtx.resume().catch(() => {});
  }

  // Handle 2-byte alignment: PCM16 means one sample spans two bytes, so an odd-length
  // chunk has a leftover byte that must be prepended to the next chunk.
  let data = bytes;
  if (state.ttsLeftoverByte !== null) {
    const combined = new Uint8Array(1 + data.length);
    combined[0] = state.ttsLeftoverByte;
    combined.set(data, 1);
    data = combined;
    state.ttsLeftoverByte = null;
  }
  if (data.length % 2 !== 0) {
    state.ttsLeftoverByte = data[data.length - 1];
    data = data.slice(0, data.length - 1);
  }
  if (data.length < 2) return;

  // Int16 → Float32 for Web Audio
  const pcm16 = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

  enqueueTTSAudio(float32);
}

function enqueueTTSAudio(float32Data) {
  if (!state.voiceAudioCtx || state.voiceAudioCtx.state === "closed") return;
  const buffer = state.voiceAudioCtx.createBuffer(1, float32Data.length, 24000);
  buffer.getChannelData(0).set(float32Data);

  const source = state.voiceAudioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.voiceAudioCtx.destination);

  // Schedule gapless playback: each buffer starts exactly when the previous ends.
  const now = state.voiceAudioCtx.currentTime;
  if (state.ttsNextStartTime < now) state.ttsNextStartTime = now;
  source.start(state.ttsNextStartTime);
  state.ttsNextStartTime += buffer.duration;

  scheduledSources.add(source);
  state.voiceIsPlaying = true;
  source.onended = () => {
    scheduledSources.delete(source);
    try { source.disconnect(); } catch {}
    if (state.voiceAudioCtx && state.voiceAudioCtx.currentTime >= state.ttsNextStartTime - 0.01) {
      state.voiceIsPlaying = false;
    }
  };
}

// Mic audio processor — captures PCM16 24kHz and sends via WS as binary frames.
// Critical: we MUST zero the output buffer on every callback. The processor is wired
// to destination via silentGain (ScriptProcessor requires an outgoing connection to
// fire onaudioprocess), and on some mobile browsers the output channel contains
// uninitialized memory — that garbage leaks through the gain node as buzzing /
// static. Explicitly filling with zeros fixes it.
export function voiceMicHandler(e) {
  e.outputBuffer.getChannelData(0).fill(0);
  if (!state.voiceSessionActive || state.voiceMuted) return;
  const float32 = e.inputBuffer.getChannelData(0);
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(pcm16.buffer);
}

// Immediate flush of all queued/playing audio (user interrupt). Stops every
// scheduled BufferSource and resets the scheduling cursor. KEEPS the AudioContext
// alive — recreating it on mobile leaves the new context permanently suspended
// (see note above on scheduledSources).
export function stopTTSPlayback() {
  for (const src of scheduledSources) {
    try { src.stop(); src.disconnect(); } catch {}
  }
  scheduledSources.clear();
  state.voiceAudioQueue = [];
  state.voiceIsPlaying = false;
  state.ttsLeftoverByte = null;
  state.ttsNextStartTime = state.voiceAudioCtx ? state.voiceAudioCtx.currentTime : 0;
  cancelKaraoke();
  if (state.turnCompleteTimer) { clearTimeout(state.turnCompleteTimer); state.turnCompleteTimer = null; }
}
