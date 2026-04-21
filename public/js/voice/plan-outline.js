import { state } from "../state.js";
import { stopTTSPlayback } from "./audio.js";

// Plan progress strip: compact "N of M" counter + row of dots showing planner
// sections. Purpose: orient the user ("three things coming up, I'm on the first").
// Dots are clickable — clicking a later section jumps to it, clicking an earlier
// section re-plays it.

export function renderPlanOutline(data) {
  const el = document.getElementById("voice-plan-outline");
  if (!el || !data || !Array.isArray(data.sections)) return;
  if (data.sections.length === 0) { clearPlanOutline(); return; }
  const sections = data.sections;
  const active = data.activeIdx;

  el.innerHTML = "";

  // Left: "1 / 3"
  const counter = document.createElement("span");
  counter.className = "plan-counter";
  counter.textContent = `${active + 1} / ${sections.length}`;
  el.appendChild(counter);

  // Middle: row of dots with hover tooltips
  const dots = document.createElement("div");
  dots.className = "plan-dots";
  sections.forEach((sec, i) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "plan-dot" + (i === active ? " active" : i < active ? " done" : "");
    dot.dataset.idx = String(i);
    dot.title = sec.label ? `${sec.label}${sec.keyInsight ? " — " + sec.keyInsight : ""}` : `Section ${i + 1}`;
    dot.setAttribute("aria-label", dot.title);
    dot.addEventListener("click", () => jumpToPlanSection(i));
    dots.appendChild(dot);
  });
  el.appendChild(dots);

  // Right: current section's title for context
  if (sections[active]?.label) {
    const current = document.createElement("span");
    current.className = "plan-current";
    current.textContent = sections[active].label;
    el.appendChild(current);
  }

  el.classList.add("visible");
}

// Click a dot → jump. Server interrupts current TTS and voices the target section,
// preserving plan state so the outline stays put.
function jumpToPlanSection(idx) {
  if (!state.voiceSessionActive || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  stopTTSPlayback();
  state.ws.send(JSON.stringify({ type: "voice:action", action: "jump", idx }));
}

export function updatePlanOutlineActive(activeIdx) {
  const el = document.getElementById("voice-plan-outline");
  if (!el) return;
  const dots = el.querySelectorAll(".plan-dot");
  dots.forEach((p, i) => {
    p.classList.toggle("active", i === activeIdx);
    p.classList.toggle("done", i < activeIdx);
  });
  const counter = el.querySelector(".plan-counter");
  if (counter) counter.textContent = `${activeIdx + 1} / ${dots.length}`;
  const current = el.querySelector(".plan-current");
  const activeDot = dots[activeIdx];
  if (current && activeDot) {
    // The title is "label — keyInsight"; show only the label.
    const label = (activeDot.title || "").split(" — ")[0];
    current.textContent = label;
  }
}

export function clearPlanOutline() {
  const el = document.getElementById("voice-plan-outline");
  if (!el) return;
  el.innerHTML = "";
  el.classList.remove("visible");
}
