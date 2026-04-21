import { WebSocket } from "ws";
import type { CuratedSection, CuratedPlan, VoiceSessionContext } from "./types.js";
import { VOICE_TTS_VOICE, VOICE_TTS_SPEED } from "../config.js";

// --- Shared mutable voice session state ---
// Exported as getters/setters to keep call sites readable and to make refactoring to
// an encapsulated "VoiceSession" object easy later if we add multi-user support.

export const state = {
  active: false,
  sttSocket: null as WebSocket | null,
  messages: [] as Array<{ role: string; content: any }>,
  session: {} as VoiceSessionContext,
  isLLMGenerating: false,
  llmAbortController: null as AbortController | null,
  currentVoice: VOICE_TTS_VOICE,
  currentSpeed: VOICE_TTS_SPEED,
  sttTranscriptAccum: "",
  // Transcripts that arrived while the LLM was busy — drained after the turn completes
  pendingUserUtterances: [] as string[],
  // Incremented on each new turn/interrupt — stale generations stop sending audio
  genId: 0,
  // Captured when voiceSection runs; consumed by "deeper"/"save" gestures
  lastVoicedSection: null as CuratedSection | null,
  // The plan currently being voiced — referenced by outline + jump handler
  currentPlan: null as CuratedPlan | null,
};

// Monotonic sentence id so the client can match voice:speak → PCM chunks → voice:speak-end.
// Reset per session so the client can reason about freshness.
let sentenceIdCounter = 0;
export function nextSentenceId(): number { sentenceIdCounter += 1; return sentenceIdCounter; }
export function resetSentenceId() { sentenceIdCounter = 0; }

// Rotating index into FILLER_PHRASES so consecutive tool calls don't play the same clip.
let fillerIdx = 0;
export function nextFillerIdx(): number { return fillerIdx++; }
export function resetFillerIdx() { fillerIdx = 0; }
