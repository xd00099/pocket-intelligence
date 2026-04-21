import { state } from "../state.js";
import { dom } from "../dom.js";
import { logActivity } from "../activity.js";
import { openNote } from "../notes/browser.js";
import { voiceMicHandler, stopTTSPlayback } from "./audio.js";
import { initGestures } from "./gestures.js";

// Voice session lifecycle: mic + audio context + session state. Everything that
// touches the `voice:start` / `voice:stop` handshake with the server lives here.

// Preset prompts surface in the voice panel as one-click starters. Each is a full
// instruction to the planner framed as a teaching / quizzing / podcast tone.
export const VOICE_PRESETS = {
  briefing: { prompt: `Start a daily review session. Read log.md to find recently added topics, then read the most recent article in full.

Your job is to be a teacher helping me REVIEW and RETAIN what I recently learned. Don't ask me questions — just teach.

Structure it like this:
1. "So recently we covered [topic]..." — set context in one sentence
2. Walk through the key concepts from the article as if you're helping me study. "The main idea is... The important thing to remember is... One thing that's easy to miss is..."
3. Make connections: "This relates to [other topic] because..."
4. After covering the first topic thoroughly, move to the next recent topic and do the same

Speak like a tutor in a 1-on-1 review session. Warm, direct, focused on helping me remember and understand. No questions, no "what would you like to discuss" — just keep teaching through the recent material one topic at a time.` },
  quiz: { prompt: `Start a quiz session. Read log.md, pick a recently updated article, read it fully. Then immediately ask me a specific, thought-provoking question about a concept in that article. No preamble — just go straight to the question. After I answer, give honest feedback with the correct explanation, then ask the next question from a different article. Make it feel like a stimulating conversation.` },
  deepdive: { prompt: `Start a deep dive. Read log.md to find the most recently updated article, then read it in full. Now teach me the content — explain the core concepts, why they matter, how they connect to other ideas. DON'T say "I found an article about X" — just start explaining the topic directly as if you're a professor giving a lecture. After the explanation, ask me thought-provoking questions.` },
  podcast: { prompt: `Start a podcast episode about my knowledge base. Read log.md and pick 2-3 interesting topics, read those articles. Then start talking like a podcast host — weave a narrative, draw connections between topics, share surprising insights. DON'T narrate your process or acknowledge you're reading files — just start the episode with energy. Use transitions like "and here's where it gets interesting..." Keep momentum, pause occasionally for my reactions.` }
};

export function updateVoiceGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) dom.voiceTitle.textContent = "Good morning";
  else if (h >= 12 && h < 17) dom.voiceTitle.textContent = "Good afternoon";
  else dom.voiceTitle.textContent = "Good evening";
}

// Wake lock keeps the screen from sleeping during a voice session. Fails silently
// on browsers that don't support the API (older Safari).
async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
    }
  } catch {}
}
async function releaseWakeLock() {
  if (state.wakeLock) { try { await state.wakeLock.release(); } catch {} state.wakeLock = null; }
}

// Start a voice session. Captures the mic, opens a 24 kHz AudioContext for TTS
// playback, sends voice:start to the server, and wires up the ScriptProcessor for
// mic capture. `initialPrompt` = a preset or continuation instruction to trigger
// an immediate turn; `resumeContext` = prior transcript to feed back as context;
// `highlightedText` = selected text from a note to focus the plan on.
export async function startVoice(initialPrompt = null, resumeContext = null, highlightedText = null) {
  const presetName = initialPrompt ? Object.entries(VOICE_PRESETS).find(([, v]) => v.prompt === initialPrompt)?.[0] : null;
  logActivity("voice", presetName ? presetName.charAt(0).toUpperCase() + presetName.slice(1) : "Voice session", { preset: presetName || "" });

  dom.intelVoice.classList.remove("session-ended");
  dom.voiceStatus.textContent = "Connecting...";
  dom.micBtn.className = ""; dom.micLabel.textContent = "";
  acquireWakeLock();

  try {
    state.voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000 },
    });

    if (!state.voiceAudioCtx || state.voiceAudioCtx.state === "closed") {
      state.voiceAudioCtx = new AudioContext({ sampleRate: 24000 });
    }
    if (state.voiceAudioCtx.state === "suspended") await state.voiceAudioCtx.resume();
    state.voiceAudioQueue = [];
    state.voiceIsPlaying = false;

    // voice:start tells the server to open STT + prep for an LLM turn. Includes
    // session-level context so the planner can focus on the current reading.
    const startMsg = {
      type: "voice:start",
      notePath: state.currentNotePath || null,
      highlightedText: highlightedText || null,
      voice: state.selectedVoiceId,
      speed: state.selectedVoiceSpeed,
      initialPrompt: initialPrompt
        || (resumeContext ? `Here is our prior conversation for context:\n\n${resumeContext}\n\nDo not respond to this message. Wait for me to speak.` : null),
    };
    state.ws.send(JSON.stringify(startMsg));

    state.voiceSessionActive = true;
    dom.intelVoice.classList.add("session-active");

    // Capture mic audio as PCM16 24kHz and send as binary WS frames. ScriptProcessor
    // is deprecated but widely supported and gives us raw PCM; AudioWorklet would be
    // cleaner but requires a separate worklet file.
    const audioInput = state.voiceAudioCtx.createMediaStreamSource(state.voiceStream);
    const processor = state.voiceAudioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = voiceMicHandler;
    // ScriptProcessor must connect to destination to fire onaudioprocess, but we
    // don't want mic audio to play — route through a silent gain node.
    const silentGain = state.voiceAudioCtx.createGain();
    silentGain.gain.value = 0;
    audioInput.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(state.voiceAudioCtx.destination);
    state.voiceScriptProcessor = processor;
    state.voiceAudioInput = audioInput;

    dom.voiceStatus.textContent = initialPrompt ? "Starting..." : "Listening...";
    dom.micBtn.className = "active";
  } catch (err) {
    console.error("Voice error:", err);
    dom.voiceStatus.textContent = err.name === "NotAllowedError" ? "Microphone access denied." : `Error: ${err.message}`;
    dom.micLabel.textContent = "Tap to retry";
    dom.intelVoice.classList.remove("session-active");
  }
}

export function stopVoice(showEnded = true) {
  releaseWakeLock();
  state.voiceSessionActive = false;
  if (state.voiceScriptProcessor) { state.voiceScriptProcessor.disconnect(); state.voiceScriptProcessor = null; }
  if (state.voiceAudioInput) { state.voiceAudioInput.disconnect(); state.voiceAudioInput = null; }
  if (state.voiceStream) { state.voiceStream.getTracks().forEach(t => t.stop()); state.voiceStream = null; }
  stopTTSPlayback();
  // Close AudioContext fully on session end (not during interrupts).
  if (state.voiceAudioCtx && state.voiceAudioCtx.state !== "closed") {
    state.voiceAudioCtx.close().catch(() => {});
    state.voiceAudioCtx = null;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "voice:stop" }));
  }
  state.voiceMuted = false;
  dom.micBtn.className = "";
  dom.micLabel.textContent = "Tap to start";
  dom.voiceStatus.textContent = "";
  dom.intelVoice.classList.remove("session-active");
  if (showEnded && dom.transcriptEl.children.length > 0) dom.intelVoice.classList.add("session-ended");
  else dom.intelVoice.classList.remove("session-ended");
}

function resetVoiceToHome() {
  dom.intelVoice.classList.remove("session-active", "session-ended");
  dom.transcriptEl.innerHTML = "";
  dom.micBtn.className = "";
  dom.micLabel.textContent = "Tap to start";
  dom.voiceStatus.textContent = "";
  updateVoiceGreeting();
  const saveBtn = document.getElementById("voice-save-btn");
  saveBtn.textContent = "Save"; saveBtn.disabled = false; saveBtn.classList.remove("saved");
}

function getTranscriptHistory() {
  const entries = dom.transcriptEl.querySelectorAll(".transcript-entry");
  if (!entries.length) return null;
  const lines = [];
  entries.forEach(el => {
    const role = el.dataset.role === "user" ? "User" : "Assistant";
    const text = el.textContent.trim();
    if (text) lines.push(`${role}: ${text}`);
  });
  return lines.length > 0 ? lines.join("\n") : null;
}

function toggleMute() {
  if (!state.voiceStream) return;
  state.voiceMuted = !state.voiceMuted;
  state.voiceStream.getAudioTracks().forEach(t => { t.enabled = !state.voiceMuted; });
  dom.micBtn.className = state.voiceMuted ? "muted" : "active";
  dom.voiceStatus.textContent = state.voiceMuted ? "Muted" : "Listening...";
}

// Wire up all voice controls (mic toggle, preset buttons, voice/speed picker,
// save, transcript link clicks). Called once from app.js at startup.
export function initVoice() {
  dom.micBtn.addEventListener("click", () => {
    if (!state.voiceSessionActive) startVoice();
    else toggleMute();
  });
  dom.voiceEndBtn.addEventListener("click", () => stopVoice(true));
  document.getElementById("voice-new-btn").addEventListener("click", resetVoiceToHome);
  document.getElementById("voice-resume-btn").addEventListener("click", () => {
    const history = getTranscriptHistory();
    dom.intelVoice.classList.remove("session-ended");
    startVoice(null, history);
  });

  document.querySelectorAll(".voice-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      const preset = btn.dataset.preset;
      if (VOICE_PRESETS[preset]) startVoice(VOICE_PRESETS[preset].prompt);
    });
  });

  document.getElementById("voice-select").addEventListener("change", e => { state.selectedVoiceId = e.target.value; });

  // Speed pills — click swaps active. Only applied on next voice:start (changing
  // mid-session has no effect).
  document.querySelectorAll(".speed-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const v = parseFloat(pill.dataset.speed);
      if (!Number.isFinite(v)) return;
      document.querySelectorAll(".speed-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      state.selectedVoiceSpeed = v;
    });
  });

  // Save conversation
  document.getElementById("voice-save-btn").addEventListener("click", async function () {
    const btn = this;
    const entries = dom.transcriptEl.querySelectorAll(".transcript-entry");
    if (!entries.length) return;
    const lines = [];
    entries.forEach(el => {
      const role = el.dataset.role === "user" ? "**You**" : "**Agent**";
      const text = el.textContent.trim();
      if (text) lines.push(`${role}: ${text}\n`);
    });
    btn.disabled = true; btn.textContent = "Saving...";
    try {
      const res = await fetch("/api/notes/save-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: lines.join("\n") }),
      });
      if (res.ok) {
        const data = await res.json();
        btn.textContent = "Saved!"; btn.classList.add("saved");
        logActivity("note", "Saved conversation", { path: data.path });
      } else {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 2000);
      }
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 2000);
    }
  });

  // Transcript link clicks → navigate to the referenced note
  dom.transcriptEl.addEventListener("click", e => {
    const link = e.target.closest(".transcript-link");
    if (link && link.dataset.path) openNote(link.dataset.path);
  });

  // Reacquire wake lock on tab refocus during active session
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.voiceSessionActive) acquireWakeLock();
  });

  initGestures();
}
