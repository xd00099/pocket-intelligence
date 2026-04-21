import { state } from "./state.js";
import { dom } from "./dom.js";
import { initTerminal, connectTerminal } from "./terminal.js";
import { updateVoiceGreeting } from "./voice/core.js";
import { loadTasks } from "./tasks.js";

// Intel panel = right-hand side panel hosting terminal / voice / tasks tabs. Also
// owns the "context bar" that tells the user which note is the current context for
// anything they ask the panel about.

export function updateIntelContext() {
  if (state.contextDismissed || !state.currentNotePath) {
    dom.intelContextEl.style.display = "none";
    return;
  }
  const name = state.currentNotePath.split("/").pop().replace(/\.md$/, "");
  dom.intelContextText.textContent = `Context: ${name}`;
  dom.intelContextEl.style.display = "flex";
}

export function switchIntelTab(tab) {
  state.intelActiveTab = tab;
  document.querySelectorAll(".intel-tab").forEach(t => t.classList.toggle("active", t.dataset.panel === tab));
  document.querySelectorAll(".intel-body").forEach(b => b.classList.toggle("active", b.dataset.panel === tab));
  if (tab === "terminal") {
    if (!state.terminal) initTerminal();
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) { initTerminal(); connectTerminal(); }
    else if (state.fitAddon) setTimeout(() => { try { state.fitAddon.fit(); } catch {} }, 50);
  }
  if (tab === "voice") updateVoiceGreeting();
  if (tab === "tasks") loadTasks();
  updateIntelContext();
}

export function toggleIntelPanel() {
  dom.intelPanel.classList.toggle("collapsed");
  const isOpen = !dom.intelPanel.classList.contains("collapsed");
  dom.intelToggleBtn.className = isOpen ? "btn btn-accent" : "btn btn-ghost";
  if (isOpen) {
    if (state.intelActiveTab === "terminal" && state.fitAddon) {
      setTimeout(() => { try { state.fitAddon.fit(); } catch {} }, 100);
    }
    updateIntelContext();
  }
}

// Focus modes: hide the other column for distraction-free notes or intel view.
export function enterFocusNotes() { document.body.classList.add("focus-notes"); }
export function enterFocusIntel() {
  document.body.classList.add("focus-intel");
  if (state.fitAddon && state.intelActiveTab === "terminal") {
    setTimeout(() => { try { state.fitAddon.fit(); } catch {} }, 50);
  }
}
export function exitFocus() {
  document.body.classList.remove("focus-notes", "focus-intel");
  if (state.fitAddon && state.intelActiveTab === "terminal") {
    setTimeout(() => { try { state.fitAddon.fit(); } catch {} }, 50);
  }
}

// Wire up all intel panel controls. Called from app.js during startup.
export function initIntelPanel() {
  document.getElementById("intel-context-close").addEventListener("click", () => {
    state.contextDismissed = true;
    dom.intelContextEl.style.display = "none";
  });

  document.querySelectorAll(".intel-tab").forEach(tab => {
    tab.addEventListener("click", () => switchIntelTab(tab.dataset.panel));
  });
  dom.intelToggleBtn.addEventListener("click", toggleIntelPanel);
  document.getElementById("intel-close-btn").addEventListener("click", () => {
    if (document.body.classList.contains("focus-intel")) { exitFocus(); return; }
    dom.intelPanel.classList.add("collapsed");
    dom.intelToggleBtn.className = "btn btn-ghost";
  });

  // Draggable resize handle between notes and intel panel
  const resizeHandle = document.getElementById("intel-resize");
  resizeHandle.addEventListener("mousedown", e => {
    e.preventDefault(); state.resizing = true;
    resizeHandle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", e => {
    if (!state.resizing) return;
    const newWidth = Math.max(280, Math.min(800, window.innerWidth - e.clientX));
    dom.intelPanel.style.width = newWidth + "px";
    if (state.fitAddon && state.intelActiveTab === "terminal") {
      try { state.fitAddon.fit(); } catch {}
    }
  });
  document.addEventListener("mouseup", () => {
    if (state.resizing) {
      state.resizing = false;
      resizeHandle.classList.remove("active");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });

  document.getElementById("focus-btn").addEventListener("click", enterFocusNotes);
  document.getElementById("intel-focus-btn").addEventListener("click", enterFocusIntel);
  document.getElementById("focus-exit").addEventListener("click", exitFocus);
}
