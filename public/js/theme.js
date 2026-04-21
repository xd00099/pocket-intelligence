// Light/dark theme toggle. Persists to localStorage; applied via data-theme attr on
// the root element so CSS can react with :root[data-theme="dark"] selectors.

export function getTheme() {
  return localStorage.getItem("pi-theme") || "dark";
}

export function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("pi-theme", t);
  const dark = document.querySelector(".theme-icon-dark");
  const light = document.querySelector(".theme-icon-light");
  if (dark && light) {
    dark.style.display = t === "dark" ? "" : "none";
    light.style.display = t === "light" ? "" : "none";
  }
}

// Apply saved theme on load so users don't flash an unstyled page.
setTheme(getTheme());

// xterm.js theme palette — applied when the terminal initializes or when the user
// toggles theme at runtime.
export const TERM_THEMES = {
  dark: {
    background: "#0b0d13", foreground: "#f0f2f7", cursor: "#818cf8",
    selectionBackground: "rgba(129,140,248,0.25)", black: "#0b0d13", brightBlack: "#5a6079",
  },
  light: {
    background: "#ffffff", foreground: "#111827", cursor: "#6366f1",
    selectionBackground: "rgba(99,102,241,0.2)", black: "#ffffff", brightBlack: "#9ca3af",
    white: "#111827", brightWhite: "#000000",
    red: "#dc2626", green: "#16a34a", yellow: "#d97706", blue: "#2563eb",
    magenta: "#9333ea", cyan: "#0891b2",
    brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#eab308", brightBlue: "#3b82f6",
    brightMagenta: "#a855f7", brightCyan: "#06b6d4",
  }
};
