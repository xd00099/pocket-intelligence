import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { NOTES_DIR, VOICE_TTS_VOICE, VOICE_TTS_SPEED, OPENAI_API_KEY } from "../config.js";
import { safePath, generateNotesTree } from "../lib/notes-helpers.js";
import { sendJson } from "../core/connection.js";
import { broadcastTaskEvent } from "../task-events.js";
import { state, nextSentenceId, resetSentenceId, resetFillerIdx } from "./state.js";
import { cleanVoiceText } from "./clean-text.js";
import { queueTTS, speakSentence, resetTTSQueue, estimateSpeechDurationMs } from "./tts.js";
import { openSTT, closeSTT, setSttFinalHandler } from "./stt.js";
import { planTurn } from "./planner.js";
import type { CuratedSection, CuratedPlan } from "./types.js";

// --- Orchestrator: plan → voice ---
// The orchestrator receives transcripts from STT, runs the planner, voices the plan
// through TTS, and surfaces plan outline + quote cards to the client. Interruption
// is handled via state.genId: every new turn bumps it, every in-flight loop checks it.

// Send a spoken fragment through both transcript (display) and TTS (audio) paths.
// Respects state.genId so stale fragments (interrupted turn) are dropped.
// TTS is serialized through ttsChain so concurrent callers (e.g. filler + response)
// don't interleave PCM bytes on the WebSocket.
//
// The voice:speak event carrying the sentence text is emitted INSIDE the queueTTS
// closure so it arrives at the client just before the PCM chunks for that sentence —
// the client uses this ordering to snapshot ttsNextStartTime as the audio start time
// for karaoke word scheduling.
// sectionIdx: when the sentence belongs to a specific plan section, the client uses
// it to advance the outline pill in sync with actual audio playback (not server-side
// loop timing, which is skewed because OpenAI TTS streams faster than realtime).
export async function speakFragment(text: string, genId: number, sectionIdx?: number): Promise<void> {
  if (!text) return;
  if (state.genId !== genId || !state.active) return;
  const clean = cleanVoiceText(text);
  if (!clean) return;
  await queueTTS(async () => {
    if (state.genId !== genId || !state.active) return;
    const id = nextSentenceId();
    const estimatedDurationMs = estimateSpeechDurationMs(clean, state.currentSpeed);
    const payload: any = { type: "voice:speak", id, text: clean, estimatedDurationMs };
    if (typeof sectionIdx === "number") payload.sectionIdx = sectionIdx;
    sendJson(payload);
    const actualDurationMs = await speakSentence(clean, genId);
    // Authoritative actual duration — client recalibrates karaoke word times to fit.
    if (state.genId === genId) {
      sendJson({ type: "voice:speak-end", id, actualDurationMs });
    }
  });
}

// Voice one curated section: surface the verbatim quote as a card in the voice panel
// (source attribution), then speak the insight. The card is the primary "where this
// came from" affordance — clicking it navigates to the note.
async function voiceSection(sec: CuratedSection, genId: number, sectionIdx?: number): Promise<void> {
  if (state.genId !== genId) return;
  state.lastVoicedSection = sec;
  if (sec.highlightText) {
    broadcastTaskEvent("voice:quote", {
      text: sec.highlightText,
      notePath: sec.notePath || null,
      heading: sec.heading || null,
    });
  }
  await speakFragment(sec.keyInsight, genId, sectionIdx);
}

// Voice a full plan end-to-end: preamble → every section → optional followUp.
// Plan-progress advancement is NOT emitted here — the client fires it based on
// actual audio playback (via sectionIdx in voice:speak), because OpenAI TTS streams
// faster than realtime and a server-side emit would race ahead of the listener.
async function voicePlan(plan: CuratedPlan, genId: number): Promise<void> {
  if (state.genId !== genId) return;
  await speakFragment(plan.preamble, genId);

  for (let i = 0; i < plan.sections.length; i++) {
    if (state.genId !== genId) return;
    await voiceSection(plan.sections[i], genId, i);
  }

  if (plan.followUp && state.genId === genId) {
    await speakFragment(plan.followUp, genId);
  }
}

// Short topical label for an outline pill. Planner is instructed to provide `title`;
// if missing we fall back to a prefix of keyInsight (with an ellipsis) so the pill
// still renders something readable rather than being blank.
function pillLabelFor(sec: CuratedSection): string {
  if (sec.title && sec.title.trim()) return sec.title.trim();
  const words = (sec.keyInsight || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 4) return words.join(" ");
  return words.slice(0, 4).join(" ") + "…";
}

// Broadcast the full plan outline so the client can render the progress strip.
// `keyInsight` is included so the client can surface it as tooltip/aria text.
function broadcastPlanOutline(plan: CuratedPlan, activeIdx: number) {
  broadcastTaskEvent("voice:plan", {
    preamble: plan.preamble,
    sections: plan.sections.map((s, i) => ({
      idx: i,
      label: pillLabelFor(s),
      keyInsight: s.keyInsight,
      notePath: s.notePath || null,
      heading: s.heading || null,
    })),
    activeIdx,
  });
}

// --- Main orchestrator: route, plan, voice ---
export async function runVoiceTurn(userText: string): Promise<void> {
  if (state.isLLMGenerating || !state.active) return;
  state.isLLMGenerating = true;
  state.genId++;
  const myGenId = state.genId;
  state.llmAbortController = new AbortController();
  const signal = state.llmAbortController.signal;

  state.messages.push({ role: "user", content: userText });
  if (state.messages.length > 50) state.messages = state.messages.slice(-50);

  try {
    // Every turn is a new topic: clear prior plan, run planner, voice it end-to-end.
    state.currentPlan = null;
    broadcastTaskEvent("voice:plan-clear", {});
    sendJson({ type: "voice:planning" });

    const plan = await planTurn(userText, state.messages.slice(0, -1), myGenId, signal);
    if (state.genId !== myGenId) return;

    sendJson({ type: "voice:llm-start" });

    if (!plan) {
      const fallback = "I hit a snag looking that up. Mind saying it again?";
      await speakFragment(fallback, myGenId);
      state.messages.push({ role: "assistant", content: fallback });
    } else {
      state.currentPlan = plan;
      if (plan.sections.length > 0) broadcastPlanOutline(plan, 0);
      await voicePlan(plan, myGenId);
      if (state.genId === myGenId) {
        const parts: string[] = [plan.preamble];
        for (const s of plan.sections) parts.push(s.keyInsight);
        if (plan.followUp) parts.push(plan.followUp);
        const spoken = parts.map(cleanVoiceText).join(" ");
        state.messages.push({ role: "assistant", content: spoken });
      }
    }

    if (state.genId === myGenId) {
      sendJson({ type: "voice:tts-done" });
    }
  } catch (err: any) {
    if (err.name !== "AbortError") {
      console.error("[Voice Turn] Error:", err.message);
      sendJson({ type: "voice:error", error: err.message });
    }
  }

  state.isLLMGenerating = false;
  if (state.llmAbortController?.signal === signal) state.llmAbortController = null;

  // Drain utterances that arrived while we were busy.
  if (state.pendingUserUtterances.length > 0 && state.active) {
    const combined = state.pendingUserUtterances.join(" ");
    state.pendingUserUtterances = [];
    console.log(`[Voice] Draining queued utterance: "${combined.slice(0, 80)}"`);
    runVoiceTurn(combined);
  }
}

// --- Session lifecycle ---
export function startVoiceSession(opts: { notePath?: string; highlightedText?: string; voice?: string; speed?: number; initialPrompt?: string }) {
  if (!OPENAI_API_KEY) {
    sendJson({ type: "voice:error", error: "OPENAI_API_KEY not configured" });
    return;
  }

  // Capture session context for the planner (open note, highlight, folder tree).
  let noteContent: string | undefined;
  if (opts.notePath) {
    const fp = safePath(opts.notePath);
    if (fp && existsSync(fp)) { try { noteContent = readFileSync(fp, "utf8"); } catch {} }
  }
  state.session = {
    notePath: opts.notePath,
    noteContent,
    highlightedText: opts.highlightedText,
    notesTree: existsSync(NOTES_DIR) ? generateNotesTree(NOTES_DIR) : undefined,
  };

  state.messages = [];
  state.currentVoice = opts.voice || VOICE_TTS_VOICE;
  // Clamp to OpenAI's supported range [0.25, 4.0]; fall back to env default if absent.
  const requestedSpeed = Number(opts.speed);
  state.currentSpeed = Number.isFinite(requestedSpeed) && requestedSpeed >= 0.25 && requestedSpeed <= 4.0
    ? requestedSpeed
    : VOICE_TTS_SPEED;
  state.active = true;
  state.pendingUserUtterances = [];
  state.sttTranscriptAccum = "";
  resetSentenceId();
  resetFillerIdx();
  state.lastVoicedSection = null;
  state.currentPlan = null;

  setSttFinalHandler(runVoiceTurn);
  openSTT();

  sendJson({ type: "voice:ready" });
  console.log(`[Voice] Session started: note=${opts.notePath || "none"}, voice=${state.currentVoice}`);

  if (opts.initialPrompt) {
    runVoiceTurn(opts.initialPrompt);
  }
}

export function stopVoiceSession() {
  state.active = false;
  if (state.llmAbortController) { state.llmAbortController.abort(); state.llmAbortController = null; }
  state.isLLMGenerating = false;
  closeSTT();
  state.messages = [];
  state.session = {};
  state.lastVoicedSection = null;
  state.currentPlan = null;
  resetTTSQueue();
  sendJson({ type: "voice:ended" });
  console.log("[Voice] Session ended");
}

export function interruptVoice() {
  state.genId++; // invalidate any in-flight speakSentence streams
  if (state.llmAbortController) { state.llmAbortController.abort(); state.llmAbortController = null; }
  state.isLLMGenerating = false;
  state.pendingUserUtterances = [];
  resetTTSQueue();
  sendJson({ type: "voice:clear-audio" });
  console.log("[Voice] Interrupted");
}

// Softer variant of interruptVoice that preserves currentPlan state so jump handlers
// can resume voicing without wiping the outline.
function softInterrupt() {
  state.genId++;
  if (state.llmAbortController) { state.llmAbortController.abort(); state.llmAbortController = null; }
  state.isLLMGenerating = false;
  state.pendingUserUtterances = [];
  resetTTSQueue();
  sendJson({ type: "voice:clear-audio" });
}

// --- Gesture actions (from voice:action WS message) ---
// Surfaces during active session:
//   deeper — re-plan with the last voiced section as the focus (interrupts current TTS)
//   save   — append the last voiced section to voice-saved.md (non-interrupting)
//   jump   — click a plan-outline pill: voice from that section onwards
export function handleVoiceAction(action: string, msg: any) {
  if (!state.active) return;
  if (action === "save") { saveLastVoicedSection(); return; }

  if (action === "jump") {
    const idx = Number(msg?.idx);
    if (!Number.isFinite(idx)) return;
    jumpToPlanSection(idx);
    return;
  }

  if (action === "deeper") {
    interruptVoice();
    const focus = state.lastVoicedSection?.keyInsight
      || state.lastVoicedSection?.highlightText
      || "the point you just made";
    runVoiceTurn(`Go deeper on this: ${focus}`);
  }
}

// Jump to a specific section of the current plan and voice from there to the end.
// Preserves currentPlan so the outline stays intact.
async function jumpToPlanSection(idx: number): Promise<void> {
  if (!state.currentPlan) return;
  if (idx < 0 || idx >= state.currentPlan.sections.length) return;
  softInterrupt();

  state.isLLMGenerating = true;
  state.genId++;
  const myGenId = state.genId;
  state.llmAbortController = new AbortController();
  const mySignal = state.llmAbortController.signal;

  try {
    sendJson({ type: "voice:llm-start" });
    // Immediate pill update for responsiveness (user clicked pill idx, they expect
    // instant visual feedback). Actual audio-time sync still happens when the
    // section's voice:speak fires on the client.
    broadcastTaskEvent("voice:plan-progress", { activeIdx: idx });
    for (let i = idx; i < state.currentPlan.sections.length; i++) {
      if (state.genId !== myGenId) break;
      await voiceSection(state.currentPlan.sections[i], myGenId, i);
    }
    if (state.genId === myGenId) {
      sendJson({ type: "voice:tts-done" });
    }
  } catch (err: any) {
    if (err.name !== "AbortError") console.error("[Jump] Error:", err.message);
  }

  state.isLLMGenerating = false;
  if (state.llmAbortController?.signal === mySignal) state.llmAbortController = null;
}

function saveLastVoicedSection() {
  const sec = state.lastVoicedSection;
  const ok = (success: boolean, detail?: string) => {
    sendJson({ type: "voice:action-ack", action: "save", ok: success, detail: detail || null });
  };
  if (!sec || !sec.keyInsight) { ok(false, "nothing voiced yet"); return; }
  if (!existsSync(NOTES_DIR)) { ok(false, "notes dir missing"); return; }

  const savedPath = join(NOTES_DIR, "voice-saved.md");
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
  const parts: string[] = [`## ${ts}`];
  if (sec.highlightText) parts.push(`> ${sec.highlightText.replace(/\n/g, " ")}`);
  if (sec.notePath) {
    const heading = sec.heading ? ` § ${sec.heading}` : "";
    parts.push(`*from [[${sec.notePath}]]${heading}*`);
  }
  parts.push("");
  parts.push(`**Insight**: ${sec.keyInsight.replace(/\n/g, " ")}`);
  parts.push("");

  try {
    if (!existsSync(savedPath)) {
      writeFileSync(savedPath, "# Voice Highlights\n\nSaved moments from voice agent sessions.\n\n");
    }
    appendFileSync(savedPath, parts.join("\n") + "\n");
    console.log(`[Voice save] Appended to ${savedPath}`);
    ok(true, "saved");
  } catch (err: any) {
    console.error("[Voice save] Failed:", err.message);
    ok(false, err.message);
  }
}
