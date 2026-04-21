import { state, ENV } from "../state.js";
import { dom } from "../dom.js";
import { cleanTranscriptText } from "../helpers.js";
import { finalizeTranscript } from "./transcript.js";
import { updatePlanOutlineActive } from "./plan-outline.js";

// Karaoke transcript — per-word highlight synced to audio playback.
//
// Approach: each sentence is scheduled with absolute audio-clock times per word. A
// setInterval poll compares audioCtx.currentTime against each pending word's
// scheduled time and lights matches. Polling the audio clock is more robust than
// setTimeout because:
//   1. setTimeout drifts with browser throttling; polling reads the actual clock.
//   2. If audioCtx pauses/resumes, currentTime reflects reality; setTimeouts would
//      fire at wall-clock times unrelated to audio.
//   3. Interrupt = single variable bump (karaokeGenId) + queue drain.

export function beginKaraokeSentence(id, text, estimatedDurationMs, sectionIdx) {
  const clean = cleanTranscriptText(text);
  if (!clean) return;

  // Defensive: ensure context is running so currentTime advances.
  if (state.voiceAudioCtx && state.voiceAudioCtx.state === "suspended") {
    state.voiceAudioCtx.resume().catch(() => {});
  }

  // Reuse the current agent bubble if still open; otherwise create a new one.
  let bubble = dom.transcriptEl.lastElementChild;
  if (!bubble || bubble.dataset.role !== "agent" || bubble.dataset.done === "true") {
    bubble = document.createElement("div");
    bubble.className = "transcript-entry transcript-agent";
    bubble.dataset.role = "agent";
    dom.transcriptEl.appendChild(bubble);
    while (dom.transcriptEl.children.length > ENV.MAX_TRANSCRIPT_ENTRIES) {
      dom.transcriptEl.removeChild(dom.transcriptEl.firstChild);
    }
  } else if (bubble.childNodes.length > 0) {
    bubble.appendChild(document.createTextNode(" "));
  }

  const tokens = clean.trim().split(/\s+/).filter(Boolean);
  const wordElements = [];
  tokens.forEach((tok, i) => {
    if (i > 0) bubble.appendChild(document.createTextNode(" "));
    const span = document.createElement("span");
    span.className = "transcript-word";
    span.textContent = tok;
    bubble.appendChild(span);
    wordElements.push(span);
  });
  dom.transcriptEl.scrollTop = dom.transcriptEl.scrollHeight;

  // Snapshot when this sentence's audio will begin (in audioCtx time).
  // ttsNextStartTime = end of already-enqueued audio (from PCM chunks). Falls back
  // to nowAudio+0.05 if nothing is queued (very first sentence of a session).
  //
  // NOTE: we do NOT recalibrate the previous sentence's word times using ttsNext
  // between sentences, because fillers (non-voice:speak audio played between tool
  // calls) also advance ttsNext. That would lead to wildly wrong scale factors.
  // Recalibration happens per-sentence via voice:speak-end, which carries the
  // authoritative duration.
  const audioStart = state.voiceAudioCtx
    ? Math.max(state.ttsNextStartTime, state.voiceAudioCtx.currentTime + 0.05)
    : 0;
  const durationSec = Math.max(0.4, (estimatedDurationMs || 800) / 1000);

  // Per-word absolute times, weighted by character count (longer words take longer)
  const totalWeight = wordElements.reduce((s, el) => s + el.textContent.length + 1, 0) || 1;
  let cum = 0;
  const wordTimes = wordElements.map(el => {
    const t = audioStart + (cum / totalWeight) * durationSec;
    cum += el.textContent.length + 1;
    return t;
  });

  console.log(`[Karaoke] id=${id} words=${wordElements.length} audioStart=${audioStart.toFixed(2)}s duration=${durationSec.toFixed(2)}s nowAudio=${(state.voiceAudioCtx?.currentTime || 0).toFixed(2)}s ttsNext=${state.ttsNextStartTime.toFixed(2)}s section=${sectionIdx ?? "-"}`);

  state.karaokeQueue.push({
    id,
    wordElements,
    wordTimes,
    idx: 0,
    gen: state.karaokeGenId,
    audioStart,            // anchor point for recalibrate scaling
    originalDurSec: durationSec, // initial duration used to lay out wordTimes
    // Plan-outline advancement: when this sentence's AUDIO starts playing (not when
    // voice:speak arrived server-side — that's ahead of the listener because TTS
    // streams faster than realtime), fire updatePlanOutlineActive.
    planUpdateIdx: typeof sectionIdx === "number" ? sectionIdx : null,
    planUpdateFired: false,
  });
  if (!state.karaokePoll) {
    state.karaokePoll = setInterval(tickKaraoke, 40);
  }
}

// Recalibrate a sentence's word times using the server-reported actual audio
// duration. Each word's time was originally `audioStart + fraction * originalDurSec`.
// Preserve audioStart and scale each word's offset by the new/old duration ratio.
export function recalibrateKaraokeSentence(id, actualDurationMs) {
  if (!Number.isFinite(actualDurationMs) || actualDurationMs <= 0) return;
  const entry = state.karaokeQueue.find(s => s.id === id);
  if (!entry || entry.wordTimes.length === 0 || !entry.originalDurSec) return;
  const actualDur = actualDurationMs / 1000;
  if (actualDur <= 0 || Math.abs(actualDur - entry.originalDurSec) < 0.1) return;
  const scale = actualDur / entry.originalDurSec;
  for (let i = 0; i < entry.wordTimes.length; i++) {
    entry.wordTimes[i] = entry.audioStart + (entry.wordTimes[i] - entry.audioStart) * scale;
  }
  entry.originalDurSec = actualDur;
}

function tickKaraoke() {
  if (!state.voiceAudioCtx || state.voiceAudioCtx.state === "closed") {
    if (state.karaokePoll) { clearInterval(state.karaokePoll); state.karaokePoll = null; }
    return;
  }
  const now = state.voiceAudioCtx.currentTime;
  while (state.karaokeQueue.length > 0) {
    const s = state.karaokeQueue[0];
    if (s.gen !== state.karaokeGenId) { state.karaokeQueue.shift(); continue; }

    // Fire plan outline update when this sentence's audio actually reaches the
    // speaker — keeps pills in sync with what the listener hears.
    if (s.planUpdateIdx !== null && !s.planUpdateFired && s.wordTimes[0] <= now) {
      updatePlanOutlineActive(s.planUpdateIdx);
      s.planUpdateFired = true;
    }

    while (s.idx < s.wordElements.length && s.wordTimes[s.idx] <= now) {
      s.wordElements[s.idx].classList.add("spoken");
      s.idx++;
    }
    if (s.idx < s.wordElements.length) break;
    state.karaokeQueue.shift();
  }
  if (state.karaokeQueue.length === 0) {
    clearInterval(state.karaokePoll);
    state.karaokePoll = null;
  }
}

// Invalidate all pending karaoke sentences (interrupt / session end).
export function cancelKaraoke() {
  state.karaokeGenId++;
  state.karaokeQueue.length = 0;
  if (state.karaokePoll) { clearInterval(state.karaokePoll); state.karaokePoll = null; }
  if (state.turnCompleteTimer) { clearTimeout(state.turnCompleteTimer); state.turnCompleteTimer = null; }
}

// End-of-turn safety: mark any still-dim word as spoken. Runs when audio has
// ACTUALLY finished playing (scheduled by scheduleTurnComplete).
function flushKaraokeSpoken() {
  dom.transcriptEl.querySelectorAll(".transcript-word:not(.spoken)").forEach(el => el.classList.add("spoken"));
  state.karaokeQueue.length = 0;
  if (state.karaokePoll) { clearInterval(state.karaokePoll); state.karaokePoll = null; }
}

// Schedule end-of-turn effects for when audio actually finishes playing, not when
// the server stops streaming. ttsNextStartTime tracks the end of the enqueued audio
// timeline; wall-clock delay until that point = (ttsNextStartTime - currentTime).
export function scheduleTurnComplete() {
  if (state.turnCompleteTimer) { clearTimeout(state.turnCompleteTimer); state.turnCompleteTimer = null; }
  const nowAudio = state.voiceAudioCtx ? state.voiceAudioCtx.currentTime : 0;
  const audioEnd = Math.max(state.ttsNextStartTime, nowAudio);
  const delayMs = Math.max(0, (audioEnd - nowAudio) * 1000) + 150;
  state.turnCompleteTimer = setTimeout(() => {
    dom.voiceStatus.textContent = "Listening...";
    finalizeTranscript("agent");
    flushKaraokeSpoken();
    state.turnCompleteTimer = null;
  }, delayMs);
}
