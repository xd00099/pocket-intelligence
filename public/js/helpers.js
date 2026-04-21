// Small shared utilities. Kept tiny — anything bigger gets its own module.

export function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

// Used to classify file extensions for the note viewer (image/pdf/office/markdown)
export const imageExts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];
export const pdfExts = ["pdf"];
export const officeExts = ["pptx", "ppt", "docx", "doc", "xlsx", "xls"];

// HTML escape for places where we can't use textContent (building raw HTML strings).
// Cheaper than esc() since no DOM element creation.
export function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatTimeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return Math.floor(d / 60000) + "m ago";
  if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
  return Math.floor(d / 86400000) + "d ago";
}

export function formatDuration(start, end) {
  if (!start) return "";
  const d = (end || Date.now()) - start;
  if (d < 60000) return Math.floor(d / 1000) + "s";
  if (d < 3600000) return Math.floor(d / 60000) + "m " + Math.floor((d % 60000) / 1000) + "s";
  return Math.floor(d / 3600000) + "h " + Math.floor((d % 3600000) / 60000) + "m";
}

// Mirror server-side cleanVoiceText — strip markdown / newlines before DOM insert so
// transcript lines render as natural prose even if something slips past the server filter.
export function cleanTranscriptText(s) {
  if (!s) return "";
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ");
}
