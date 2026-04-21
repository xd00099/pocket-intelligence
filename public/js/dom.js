// Cached references to DOM elements looked up at module load. Collecting these in
// one place makes it obvious what the UI surface area is and avoids repeated
// document.getElementById calls scattered across modules.

export const dom = {
  // Auth + shell
  authOverlay: document.getElementById("auth-overlay"),
  authError: document.getElementById("auth-error"),
  app: document.getElementById("app"),

  // Terminal
  terminalEl: document.getElementById("terminal"),
  mobileToolbar: document.getElementById("mobile-toolbar"),
  disconnectOverlay: document.getElementById("disconnect-overlay"),

  // Voice
  voiceBody: document.getElementById("voice-body"),
  intelVoice: document.getElementById("intel-voice"),
  voiceStatus: document.getElementById("voice-status"),
  micBtn: document.getElementById("mic-btn"),
  micLabel: document.getElementById("mic-label"),
  transcriptEl: document.getElementById("transcript"),
  voiceEndBtn: document.getElementById("voice-end-btn"),
  voiceTitle: document.getElementById("voice-title"),

  // Sidebar + notes
  sidebar: document.getElementById("sidebar"),
  sidebarOverlay: document.getElementById("sidebar-overlay"),
  notesTreeEl: document.getElementById("notes-tree"),
  notesTreeWrap: document.getElementById("notes-tree-wrap"),
  notesSearchInput: document.getElementById("notes-search-input"),
  notesSearchResults: document.getElementById("notes-search-results"),
  notesContent: document.getElementById("notes-content"),
  notesScroll: document.getElementById("notes-scroll"),
  notesBreadcrumb: document.getElementById("notes-breadcrumb"),

  // Command bar
  cmdBar: document.getElementById("cmd-bar"),
  cmdInput: document.getElementById("cmd-input"),
  cmdResultsInner: document.getElementById("cmd-results-inner"),

  // Intel panel
  intelPanel: document.getElementById("intel-panel"),
  intelToggleBtn: document.getElementById("intel-toggle"),
  intelContextEl: document.getElementById("intel-context"),
  intelContextText: document.getElementById("intel-context-text"),

  // Selection toolbar
  selectionToolbar: document.getElementById("selection-toolbar"),

  // Note editing / diff
  editToggle: document.getElementById("edit-toggle"),
  tocToggleBtn: document.getElementById("toc-toggle"),
  changesBtn: document.getElementById("changes-btn"),
  noteToc: document.getElementById("note-toc"),
  noteTabsEl: document.getElementById("note-tabs"),

  // Graph + stats
  graphOverlay: document.getElementById("graph-overlay"),
  graphCanvas: document.getElementById("graph-canvas"),
  graphTooltip: document.getElementById("graph-tooltip"),
  graphStats: document.getElementById("graph-stats"),
};
