// Single source of truth for mutable app state. Other modules import this and
// mutate via `state.x = y`. Using an object (not individual let bindings) means
// ES module imports stay in sync automatically — every module sees the same
// reference and reads the latest value.

export const state = {
  // --- WebSocket / terminal ---
  ws: null,
  terminal: null,
  fitAddon: null,
  statusInterval: null,
  keepaliveInterval: null,
  reconnectAttempts: 0,

  // --- Voice session ---
  voiceStream: null,
  voiceMuted: false,
  voiceSessionActive: false,
  voiceAudioCtx: null,
  voiceAudioQueue: [],
  voiceIsPlaying: false,
  voiceScriptProcessor: null,
  voiceAudioInput: null,
  selectedVoiceId: "coral",
  selectedVoiceSpeed: 1.15,
  ttsLeftoverByte: null,
  ttsNextStartTime: 0,
  wakeLock: null,
  turnCompleteTimer: null,
  gestureAckTimer: null,

  // --- Karaoke ---
  karaokeQueue: [],
  karaokePoll: null,
  karaokeGenId: 0,

  // --- Notes ---
  notesTree: null,
  notesTreeFlat: null,
  currentNotePath: null,
  notesHistory: [],
  notesHistoryIdx: -1,
  activeBlobUrl: null,
  openTabs: [],
  selectedText: "",
  notesSearchDebounce: null,

  // --- Edit mode ---
  isEditing: false,
  editContent: "",
  editOriginal: "",
  originalEditText: "",
  tocCollapsed: false,
  tocObserver: null,
  didRevertFiles: false,

  // --- UI ---
  intelActiveTab: "terminal",
  contextDismissed: false,
  sidebarResizing: false,
  resizing: false,
  pendingUploadFiles: [],

  // --- Graph ---
  graphData: null,
  graphNodes: null,
  graphAnimFrame: null,
  graphRecenter: null,
  graphZoomAt: null,
  graphSearchQuery: "",

  // --- Command bar ---
  cmdSelectedIdx: 0,
  cmdBarOpen: false,
  cmdContentSearchTimer: null,

  // --- Tasks ---
  tasksList: [],
  tasksCronJobs: [],
  taskAutoExecute: false,
  taskOutputStreams: {},
  taskDetailId: null,
};

// Environment / constants — read-only, module-level so no need to go through state
export const ENV = {
  isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
  MAX_RECONNECT_ATTEMPTS: 5,
  MAX_HISTORY: 50,
  MAX_TABS: 8,
  MAX_TRANSCRIPT_ENTRIES: 100,
  ACTIVITY_KEY: "pi-activity",
  MAX_ACTIVITIES: 50,
  STREAK_KEY: "pi-streak",
  HIGHLIGHTS_KEY: "pi-highlights",
};
