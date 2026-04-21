import { ENV } from "../state.js";
import { dom } from "../dom.js";
import { esc } from "../helpers.js";
import { openNote } from "../notes/browser.js";
import { state } from "../state.js";

// Voice quote cards — inline source attribution.
// When the planner emits a section with a verbatim quote from a note, show a card
// in the voice panel with the quote text + source note name. Clicking the card
// opens the note and scrolls to the approximate heading. No DOM-level text
// highlighting — that was fragile (markdown syntax drift, text-node splits).

export function renderVoiceQuote(data) {
  if (!data || !data.text) return;
  const { text, notePath, heading } = data;

  const card = document.createElement("div");
  card.className = "voice-quote-card";
  card.dataset.role = "quote";
  card.dataset.done = "true"; // marked done so karaoke's bubble-finder never re-uses it

  const quoteEl = document.createElement("div");
  quoteEl.className = "voice-quote-text";
  quoteEl.textContent = text;
  card.appendChild(quoteEl);

  if (notePath) {
    const src = document.createElement("button");
    src.className = "voice-quote-source";
    src.type = "button";
    const name = notePath.split("/").pop().replace(/\.md$/, "");
    src.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="10" height="10"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="voice-quote-note">${esc(name)}</span>`;
    src.addEventListener("click", () => jumpToQuoteSource(notePath, heading));
    card.appendChild(src);
  }

  dom.transcriptEl.appendChild(card);
  while (dom.transcriptEl.children.length > ENV.MAX_TRANSCRIPT_ENTRIES) {
    dom.transcriptEl.removeChild(dom.transcriptEl.firstChild);
  }
  dom.transcriptEl.scrollTop = dom.transcriptEl.scrollHeight;
}

// Open the source note and scroll to the approximate heading if supplied.
// No text-level highlight — the quote card itself is the attribution.
async function jumpToQuoteSource(path, heading) {
  if (!path) return;
  if (state.currentNotePath !== path) {
    await openNote(path);
    await new Promise(r => setTimeout(r, 180));
  }
  const article = document.querySelector(".note-article");
  if (!article || !heading) return;
  const lowerHeading = heading.toLowerCase();
  for (const h of article.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (h.textContent.toLowerCase().includes(lowerHeading)) {
      h.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }
}
