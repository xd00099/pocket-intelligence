// Thin bootstrapper. Imports every feature module, wires up init hooks, and runs
// the auth check → app startup. No business logic lives here.

import "./theme.js"; // applies saved theme on import as a side effect
import { state, ENV } from "./state.js";
import { dom } from "./dom.js";
import { initIntelPanel } from "./intel-panel.js";
import { initTerminal, connectTerminal, initMobileToolbar } from "./terminal.js";
import { initNotesBrowser, loadNotesTree } from "./notes/browser.js";
import { initTabs } from "./notes/tabs.js";
import { initToc } from "./notes/toc.js";
import { initSelectionToolbar } from "./notes/selection.js";
import { initEditMode } from "./notes/edit-mode.js";
import { initGitSync, checkNotesStatus } from "./notes/git-sync.js";
import { initUpload } from "./upload.js";
import { initCmdBar } from "./cmd-bar.js";
import { initGraph_ } from "./graph.js";
import { initStats } from "./stats.js";
import { initTasks } from "./tasks.js";
import { initShortcuts } from "./shortcuts.js";
import { initVoice } from "./voice/core.js";
import { switchIntelTab } from "./intel-panel.js";
import { setTheme, getTheme, TERM_THEMES } from "./theme.js";

// --- URL error surfacing ---
// OAuth failures redirect back with ?error=... — show it on the auth overlay.
const urlParams = new URLSearchParams(location.search);
if (urlParams.has("error")) {
  dom.authError.textContent = "Authentication failed. Please try again.";
  dom.authError.style.display = "block";
  history.replaceState({}, "", "/");
}

// Theme toggle applies both to document theme and xterm.js.
document.getElementById("theme-toggle").addEventListener("click", () => {
  const newTheme = getTheme() === "dark" ? "light" : "dark";
  setTheme(newTheme);
  if (state.terminal) state.terminal.options.theme = TERM_THEMES[newTheme] || TERM_THEMES.dark;
});

// Wire up every module's DOM listeners. Order matters only for side effects
// (setTheme runs on import; everything else is idempotent).
initIntelPanel();
initMobileToolbar();
initNotesBrowser();
initTabs();
initToc();
initSelectionToolbar();
initEditMode();
initGitSync();
initUpload();
initCmdBar();
initGraph_();
initStats();
initTasks();
initShortcuts();
initVoice();

// --- Startup ---

function showLogin() {
  dom.authOverlay.classList.remove("hidden");
  dom.app.classList.remove("visible");
}

function showApp() {
  dom.authOverlay.classList.add("hidden");
  dom.app.classList.add("visible");
  loadNotesTree();
  checkNotesStatus();
  setInterval(checkNotesStatus, 30000);
  switchIntelTab("terminal");
  if (ENV.isMobile) {
    dom.intelPanel.classList.add("collapsed");
    dom.intelToggleBtn.className = "btn btn-ghost";
  }
}

(async () => {
  try {
    const res = await fetch("/api/auth/check");
    if (res.ok) showApp();
    else showLogin();
  } catch { showLogin(); }
})();

// Register service worker for PWA offline support. Failure is non-fatal.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
