// Strip markdown + normalize whitespace so TTS and transcript get clean spoken prose.
// Applied at every LLM→TTS and LLM→transcript boundary as defense-in-depth against
// the planner leaking **bold**, bullets, or line breaks into the spoken output.
export function cleanVoiceText(text: string): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")         // code fences
    .replace(/`([^`]+)`/g, "$1")             // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // **bold**
    .replace(/\*([^*\n]+)\*/g, "$1")         // *italic*
    .replace(/__([^_]+)__/g, "$1")           // __bold__
    .replace(/_([^_\n]+)_/g, "$1")           // _italic_
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url)
    .replace(/^#{1,6}\s+/gm, "")             // # headings
    .replace(/^\s*[-*+]\s+/gm, "")           // - bullets
    .replace(/^\s*\d+\.\s+/gm, "")           // 1. numbered
    .replace(/\n+/g, " ")                    // newlines → spaces
    .replace(/\s{2,}/g, " ")                 // collapse whitespace
    .trim();
}
