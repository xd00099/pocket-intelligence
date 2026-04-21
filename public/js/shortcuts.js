import { state } from "./state.js";
import { dom } from "./dom.js";
import { toggleIntelPanel, switchIntelTab, exitFocus } from "./intel-panel.js";
import { openCmdBar, closeCmdBar } from "./cmd-bar.js";
import { closeGraph } from "./graph.js";

// Global keyboard shortcuts. Escape bubbles through overlays in a priority order
// (graph → focus mode → cmd bar) so the user can dismiss whatever's on top.

export function initShortcuts() {
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      state.cmdBarOpen ? closeCmdBar() : openCmdBar();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); dom.sidebar.classList.toggle("collapsed"); }
    if ((e.metaKey || e.ctrlKey) && e.key === "j") { e.preventDefault(); toggleIntelPanel(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "1") { e.preventDefault(); switchIntelTab("terminal"); }
    if ((e.metaKey || e.ctrlKey) && e.key === "2") { e.preventDefault(); switchIntelTab("voice"); }
    if ((e.metaKey || e.ctrlKey) && e.key === "3") { e.preventDefault(); switchIntelTab("tasks"); }
    if (e.key === "Escape") {
      if (dom.graphOverlay.classList.contains("visible")) closeGraph();
      else if (document.body.classList.contains("focus-notes") || document.body.classList.contains("focus-intel")) exitFocus();
      else if (state.cmdBarOpen) closeCmdBar();
    }
  });
}
