import { ENV } from "../state.js";
import { dom } from "../dom.js";
import { cleanTranscriptText } from "../helpers.js";
import { openNote } from "../notes/browser.js";

// Replace (not append) the current in-flight bubble's text. Used for STT interim
// transcripts where each delta carries the FULL cumulative text so far. Creates a
// bubble if one isn't already open for the given role.
export function setInterimTranscript(role, text) {
  const clean = cleanTranscriptText(text);
  if (!clean) return;
  let last = dom.transcriptEl.lastElementChild;
  if (!last || last.dataset.role !== role || last.dataset.done === "true") {
    last = document.createElement("div");
    last.className = `transcript-entry transcript-${role} transcript-interim`;
    last.dataset.role = role;
    dom.transcriptEl.appendChild(last);
    while (dom.transcriptEl.children.length > ENV.MAX_TRANSCRIPT_ENTRIES) {
      dom.transcriptEl.removeChild(dom.transcriptEl.firstChild);
    }
  }
  last.textContent = clean;
  dom.transcriptEl.scrollTop = dom.transcriptEl.scrollHeight;
}

// Close the current bubble for `role` (marks it done). Also linkifies note paths so
// the user can click through to the source.
export function finalizeTranscript(role) {
  const last = dom.transcriptEl.lastElementChild;
  if (last && last.dataset.role === role) {
    last.dataset.done = "true";
    last.innerHTML = last.innerHTML.replace(
      /(?:[\w-]+\/)+[\w-]+\.md/g,
      match => `<span class="transcript-link" data-path="${match}">${match}</span>`
    );
  }
}

// Inline tool-call card surfaced during the planner's research loop. Clicking the
// header toggles the debug body open/closed.
export function addToolCard(toolName, toolArgs, status) {
  const card = document.createElement("div");
  card.className = "tool-card"; card.dataset.done = "true";
  const header = document.createElement("div");
  header.className = "tool-card-header";
  header.innerHTML = `<span class="tool-name">${toolName}</span><span class="tool-args">${JSON.stringify(toolArgs)}</span><span class="tool-duration">${status}</span><span class="tool-toggle">&plus;</span>`;
  card.appendChild(header);
  const body = document.createElement("div");
  body.className = "tool-card-body";
  card.appendChild(body);
  header.addEventListener("click", () => {
    body.classList.toggle("open");
    header.querySelector(".tool-toggle").innerHTML = body.classList.contains("open") ? "&minus;" : "&plus;";
  });
  dom.transcriptEl.appendChild(card);
  dom.transcriptEl.scrollTop = dom.transcriptEl.scrollHeight;
  return { card, body, header };
}

// Render the server's debug payload (search hits, file listing, read stats, errors)
// into a tool card body. Clickable transcript-links navigate to the source note.
export function renderToolDebug(body, debug) {
  if (!debug) return;
  body.innerHTML = "";

  const info = document.createElement("div");
  info.className = "tool-section";
  info.innerHTML = `<div class="tool-section-label">Execution</div><div class="tool-section-content">Tool: ${debug.tool || "?"}\nDuration: ${debug.duration || "?"}ms</div>`;
  body.appendChild(info);

  if (debug.fileDetails && debug.fileDetails.length > 0) {
    const sec = document.createElement("div"); sec.className = "tool-section";
    sec.innerHTML = `<div class="tool-section-label">Matches (${debug.matchCount} files)</div>`;
    const list = document.createElement("ul"); list.className = "tool-files";
    for (const f of debug.fileDetails) {
      const li = document.createElement("li");
      const link = document.createElement("span");
      link.className = "transcript-link"; link.dataset.path = f.path;
      link.textContent = f.path; link.style.cursor = "pointer";
      link.addEventListener("click", () => openNote(f.path));
      li.appendChild(link);
      if (f.snippet) {
        const snip = document.createElement("span");
        snip.className = "file-snippet";
        snip.textContent = f.snippet.slice(0, 200);
        li.appendChild(snip);
      }
      list.appendChild(li);
    }
    sec.appendChild(list); body.appendChild(sec);
  }

  if (debug.entries) {
    const sec = document.createElement("div"); sec.className = "tool-section";
    sec.innerHTML = `<div class="tool-section-label">Contents (${debug.entryCount} items)</div>`;
    const list = document.createElement("ul"); list.className = "tool-files";
    for (const e of debug.entries.slice(0, 30)) {
      const li = document.createElement("li");
      li.textContent = e.type === "dir" ? `${e.name} (${e.children} items)` : `${e.name} (${(e.sizeBytes / 1024).toFixed(1)}KB)`;
      list.appendChild(li);
    }
    sec.appendChild(list); body.appendChild(sec);
  }

  if (debug.sizeBytes !== undefined) {
    const sec = document.createElement("div"); sec.className = "tool-section";
    const fpath = debug.resolved || debug.path;
    sec.innerHTML = `<div class="tool-section-label">File Info</div><div class="tool-section-content"><span class="transcript-link" style="cursor:pointer">${fpath}</span>\nSize: ${(debug.sizeBytes / 1024).toFixed(1)}KB${debug.truncated ? "\nTruncated: yes" : ""}</div>`;
    sec.querySelector(".transcript-link").addEventListener("click", () => openNote(fpath));
    body.appendChild(sec);
  }

  if (debug.error) {
    const sec = document.createElement("div"); sec.className = "tool-section";
    sec.innerHTML = `<div class="tool-section-label">Error</div><div class="tool-section-content" style="color:var(--red)">${debug.error}</div>`;
    body.appendChild(sec);
  }
}
