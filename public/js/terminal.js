import { Terminal } from "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm";
import { FitAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm";
import { WebLinksAddon } from "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/+esm";
import { state, ENV } from "./state.js";
import { dom } from "./dom.js";
import { getTheme, TERM_THEMES } from "./theme.js";
import { checkNotesStatus } from "./notes/git-sync.js";
import { dispatchWsMessage } from "./ws.js";

// xterm.js terminal that pipes through the WebSocket to the server-side Claude Code
// pty. The terminal also hosts the main WebSocket — every WS event passes through
// connectTerminal's onmessage and is then dispatched to domain handlers.

export function initTerminal() {
  if (state.terminal) state.terminal.dispose();
  state.terminal = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERM_THEMES[getTheme()] || TERM_THEMES.dark,
    allowProposedApi: true, scrollback: 10000,
  });
  state.fitAddon = new FitAddon();
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.loadAddon(new WebLinksAddon());
  dom.terminalEl.innerHTML = "";
  state.terminal.open(dom.terminalEl);
  try { state.fitAddon.fit(); } catch {}

  state.terminal.onData(data => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "input", data }));
    }
  });
  state.terminal.onResize(({ cols, rows }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });

  // Install a single window resize listener — re-fit the terminal if visible.
  if (!window._resizeHandler) {
    window._resizeHandler = () => {
      if (state.fitAddon && state.intelActiveTab === "terminal") {
        try { state.fitAddon.fit(); } catch {}
      }
    };
    window.addEventListener("resize", window._resizeHandler);
  }
}

export function connectTerminal() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${location.host}/ws`);

  state.ws.onopen = () => {
    state.reconnectAttempts = 0;
    dom.disconnectOverlay.classList.remove("visible");
    if (state.terminal) state.ws.send(JSON.stringify({ type: "resize", cols: state.terminal.cols, rows: state.terminal.rows }));
    checkNotesStatus();
    if (state.statusInterval) clearInterval(state.statusInterval);
    state.statusInterval = setInterval(checkNotesStatus, 30000);
    if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
    state.keepaliveInterval = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: "ping" }));
    }, 30000);
  };

  state.ws.binaryType = "arraybuffer";
  state.ws.onmessage = event => dispatchWsMessage(event);

  // Reconnect loop: exponential-ish backoff up to MAX_RECONNECT_ATTEMPTS. If the
  // server returns 401 on reconnect (session expired), show login instead.
  state.ws.onclose = () => {
    if (state.statusInterval) { clearInterval(state.statusInterval); state.statusInterval = null; }
    if (state.keepaliveInterval) { clearInterval(state.keepaliveInterval); state.keepaliveInterval = null; }
    if (state.reconnectAttempts < ENV.MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++;
      const delay = Math.min(1000 * state.reconnectAttempts, 5000);
      if (state.terminal) state.terminal.writeln("\r\n\x1b[2m[Connection lost \u2014 reconnecting...]\x1b[0m");
      setTimeout(async () => {
        try {
          const res = await fetch("/api/auth/check");
          if (res.ok) connectTerminal();
          else {
            dom.authOverlay.classList.remove("hidden");
            dom.app.classList.remove("visible");
          }
        } catch { connectTerminal(); }
      }, delay);
      return;
    }
    dom.disconnectOverlay.classList.add("visible");
  };
  state.ws.onerror = () => {};
}

// Mobile on-screen keyboard shortcuts (Ctrl-C, Esc, arrows). Sends raw key sequences
// through the pty — same as if typed on a physical keyboard.
export function initMobileToolbar() {
  const keyMap = {
    ctrlc: "\x03", tab: "\t", esc: "\x1b", slash: "/",
    up: "\x1b[A", down: "\x1b[B", enter: "\r",
  };
  dom.mobileToolbar.addEventListener("click", e => {
    const btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    e.preventDefault();
    const seq = keyMap[btn.dataset.cmd];
    if (seq && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "input", data: seq }));
    }
  });

  // Disconnect overlay click — reinitialize the terminal + connect.
  dom.disconnectOverlay.addEventListener("click", () => {
    dom.disconnectOverlay.classList.remove("visible");
    initTerminal(); connectTerminal();
  });
}
