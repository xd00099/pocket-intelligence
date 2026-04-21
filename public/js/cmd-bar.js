import { marked } from "https://cdn.jsdelivr.net/npm/marked@9.1.6/+esm";
import { state } from "./state.js";
import { dom } from "./dom.js";
import { esc } from "./helpers.js";
import { toggleIntelPanel, switchIntelTab, enterFocusNotes, enterFocusIntel } from "./intel-panel.js";
import { openNote } from "./notes/browser.js";
import { openUploadOverlay } from "./upload.js";
import { openDiffReview } from "./notes/git-sync.js";
import { openGraph, closeGraph } from "./graph.js";
import { openStats } from "./stats.js";
import { startVoice, VOICE_PRESETS } from "./voice/core.js";

const hljs = window.hljs;

// Command bar — Ctrl-K spotlight with:
//   - fuzzy note search (name + path)
//   - `/commands` prefix for actions (graph, stats, presets, etc.)
//   - `?question` prefix for AI Q&A against the knowledge base
//   - content search (3+ chars, debounced grep)
// Also doubles as the graph node search when the graph overlay is open.

function getNotesFlat() {
  if (state.notesTreeFlat) return state.notesTreeFlat;
  const acc = [];
  function walk(items) {
    if (!items) return;
    for (const item of items) {
      if (item.type === "file") acc.push(item);
      if (item.children) walk(item.children);
    }
  }
  walk(state.notesTree);
  state.notesTreeFlat = acc;
  return acc;
}

const CMD_ACTIONS = [
  { id: "graph", icon: "\u25CE", name: "Knowledge Graph", desc: "Visualize note connections", action: () => openGraph() },
  { id: "stats", icon: "\u2261", name: "Vault Stats", desc: "Notes, topics, study streak", action: () => openStats() },
  { id: "briefing", icon: "\u2600\uFE0F", name: "Daily Briefing", desc: "Voice: catch up on latest", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("voice"); setTimeout(() => startVoice(VOICE_PRESETS.briefing.prompt), 100); } },
  { id: "quiz", icon: "\uD83E\uDDE0", name: "Quiz Me", desc: "Voice: test my knowledge", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("voice"); setTimeout(() => startVoice(VOICE_PRESETS.quiz.prompt), 100); } },
  { id: "deepdive", icon: "\uD83D\uDCDA", name: "Deep Dive", desc: "Voice: review a topic", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("voice"); setTimeout(() => startVoice(VOICE_PRESETS.deepdive.prompt), 100); } },
  { id: "podcast", icon: "\uD83C\uDFA7", name: "Podcast", desc: "Voice: podcast-style exploration", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("voice"); setTimeout(() => startVoice(VOICE_PRESETS.podcast.prompt), 100); } },
  { id: "upload", icon: "\u2191", name: "Upload Files", desc: "Upload files to knowledge base", action: () => { openUploadOverlay(); closeCmdBar(); } },
  { id: "tasks", icon: "\u2610", name: "Task Board", desc: "View queued and running tasks", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("tasks"); } },
  { id: "add-task", icon: "+", name: "Add Task", desc: "Queue a task for Claude Code", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("tasks"); setTimeout(() => { document.getElementById("task-add-form").style.display = "block"; document.getElementById("task-add-input").focus(); }, 100); closeCmdBar(); } },
  { id: "terminal", icon: ">_", name: "Terminal", desc: "Open Claude Code", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("terminal"); } },
  { id: "voice", icon: "\uD83C\uDF99", name: "Voice Agent", desc: "Open voice panel", action: () => { if (dom.intelPanel.classList.contains("collapsed")) toggleIntelPanel(); switchIntelTab("voice"); } },
  { id: "focus", icon: "\u25CB", name: "Focus Notes", desc: "Distraction-free reading", shortcut: "", action: () => enterFocusNotes() },
  { id: "focus-intel", icon: "\u26F6", name: "Focus Intel", desc: "Full-screen intelligence", action: () => enterFocusIntel() },
  { id: "pull", icon: "\u2193", name: "Pull Notes", desc: "Pull latest from GitHub", action: async () => { document.querySelector(".pull-btn")?.click(); closeCmdBar(); } },
  { id: "diff", icon: "\u2191", name: "Review & Push", desc: "Review changes and push to GitHub", action: () => { openDiffReview(); closeCmdBar(); } },
];

export function openCmdBar() {
  dom.cmdBar.classList.add("visible");
  dom.cmdInput.value = "";
  state.cmdSelectedIdx = 0;
  state.cmdBarOpen = true;
  renderCmdResults("");
  setTimeout(() => dom.cmdInput.focus(), 50);
}

export function closeCmdBar() {
  dom.cmdBar.classList.remove("visible", "expanded");
  dom.cmdInput.value = "";
  dom.cmdInput.blur();
  state.cmdBarOpen = false;
  setTimeout(() => { dom.cmdResultsInner.innerHTML = ""; }, 200);
}

function renderCmdResults(query) {
  const q = query.toLowerCase().trim();

  // Graph-search mode: when the graph overlay is open, the cmd bar acts as a node filter
  if (dom.graphOverlay.classList.contains("visible")) {
    state.graphSearchQuery = q;
    if (!q) {
      dom.cmdResultsInner.innerHTML = "";
      dom.cmdBar.classList.remove("expanded");
      return;
    }
    if (state.graphNodes) {
      const matches = state.graphNodes.filter(n =>
        n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
      ).slice(0, 10);
      if (matches.length > 0) {
        dom.cmdResultsInner.innerHTML = `<div class="cmd-section-label">Graph Nodes</div>` +
          matches.map((n, i) =>
            `<div class="cmd-result${i === state.cmdSelectedIdx ? " selected" : ""}" data-type="graph-node" data-path="${esc(n.path)}"><div class="cmd-result-icon" style="background:${n.color}20;color:${n.color}">\u25CF</div><div class="cmd-result-info"><div class="cmd-result-name">${esc(n.name)}</div><div class="cmd-result-desc">${esc(n.path)} \u00B7 ${n.conns} connections</div></div></div>`
          ).join("");
        dom.cmdBar.classList.add("expanded");
      } else {
        dom.cmdResultsInner.innerHTML = `<div class="cmd-section-label" style="text-align:center;padding:16px">No matching nodes</div>`;
        dom.cmdBar.classList.add("expanded");
      }
    }
    return;
  }

  // ?question → AI chat mode
  if (q.startsWith("?") && q.length > 1) {
    const question = q.slice(1).trim();
    dom.cmdResultsInner.innerHTML = `<div class="cmd-section-label">Ask AI</div><div class="cmd-result" data-type="chat" data-question="${esc(question)}"><div class="cmd-result-icon accent">?</div><div class="cmd-result-info"><div class="cmd-result-name">Ask: ${esc(question.slice(0, 60))}</div><div class="cmd-result-desc">Search knowledge base and answer with AI</div></div></div>`;
    dom.cmdBar.classList.add("expanded");
    return;
  }

  // /command → actions
  if (q.startsWith("/")) {
    const cmdQ = q.slice(1);
    const filtered = cmdQ ? CMD_ACTIONS.filter(c => c.name.toLowerCase().includes(cmdQ) || c.id.includes(cmdQ)) : CMD_ACTIONS;
    dom.cmdResultsInner.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-result${i === state.cmdSelectedIdx ? " selected" : ""}" data-type="cmd" data-idx="${c.id}"><div class="cmd-result-icon accent">${c.icon}</div><div class="cmd-result-info"><div class="cmd-result-name">${esc(c.name)}</div><div class="cmd-result-desc">${esc(c.desc)}</div></div>${c.shortcut ? `<span class="cmd-result-shortcut">${c.shortcut}</span>` : ""}</div>`
    ).join("");
    dom.cmdBar.classList.toggle("expanded", filtered.length > 0);
    return;
  }

  // Default: notes + commands in two sections
  let html = "", totalResults = 0;
  if (state.notesTree && q) {
    const files = getNotesFlat();
    const noteMatches = files.filter(f =>
      f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    ).slice(0, 8);
    if (noteMatches.length > 0) {
      html += `<div class="cmd-section-label">Notes</div>`;
      html += noteMatches.map((f, i) => {
        const ext = f.name.split(".").pop().toLowerCase();
        const icons = { md: "\uD83D\uDCDD", pdf: "\uD83D\uDCC4", pptx: "\uD83D\uDCCA" };
        return `<div class="cmd-result${i === state.cmdSelectedIdx ? " selected" : ""}" data-type="note" data-path="${esc(f.path)}"><div class="cmd-result-icon">${icons[ext] || "\uD83D\uDCCE"}</div><div class="cmd-result-info"><div class="cmd-result-name">${esc(f.name.replace(/\.md$/, ""))}</div><div class="cmd-result-desc">${esc(f.path)}</div></div></div>`;
      }).join("");
      totalResults += noteMatches.length;
    }
  }
  const cmdMatches = q
    ? CMD_ACTIONS.filter(c => c.name.toLowerCase().includes(q)).slice(0, 4)
    : CMD_ACTIONS.slice(0, 4);
  if (cmdMatches.length > 0) {
    html += `<div class="cmd-section-label">${q ? "Commands" : "Quick Actions"}</div>`;
    html += cmdMatches.map((c, i) => {
      const idx = totalResults + i;
      return `<div class="cmd-result${idx === state.cmdSelectedIdx ? " selected" : ""}" data-type="cmd" data-idx="${c.id}"><div class="cmd-result-icon accent">${c.icon}</div><div class="cmd-result-info"><div class="cmd-result-name">${esc(c.name)}</div><div class="cmd-result-desc">${esc(c.desc)}</div></div></div>`;
    }).join("");
    totalResults += cmdMatches.length;
  }

  // Debounced content search — fires after 300ms of typing for queries ≥ 3 chars.
  clearTimeout(state.cmdContentSearchTimer);
  if (q.length >= 3) {
    state.cmdContentSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/notes/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.results?.length > 0 && dom.cmdInput.value.trim().toLowerCase() === q) {
          const existing = dom.cmdResultsInner.querySelector(".cmd-content-results");
          if (existing) existing.remove();
          const frag = document.createElement("div"); frag.className = "cmd-content-results";
          frag.innerHTML = `<div class="cmd-section-label">Content matches</div>` +
            data.results.slice(0, 5).map(r => {
              const snippet = r.matches?.[0]?.text || "";
              const highlighted = esc(snippet.slice(0, 80)).replace(new RegExp(esc(q), "gi"), m => `<b>${m}</b>`);
              return `<div class="cmd-result" data-type="note" data-path="${esc(r.path)}"><div class="cmd-result-icon">\uD83D\uDD0D</div><div class="cmd-result-info"><div class="cmd-result-name">${esc(r.path.split("/").pop().replace(/\.md$/, ""))}</div><div class="cmd-result-desc">${highlighted}</div></div></div>`;
            }).join("");
          dom.cmdResultsInner.appendChild(frag);
          frag.querySelectorAll(".cmd-result").forEach(el => el.addEventListener("click", () => executeCmdResult(el)));
        }
      } catch {}
    }, 300);
  }

  if (!html) html = `<div class="cmd-section-label" style="text-align:center;padding:16px">No results</div>`;
  html += `<div class="cmd-hint">\u2191\u2193 navigate \u00B7 Enter select \u00B7 Esc close \u00B7 /commands \u00B7 ?ask AI</div>`;
  dom.cmdResultsInner.innerHTML = html;
  dom.cmdBar.classList.toggle("expanded", totalResults > 0 || q.length > 0);
}

async function executeCmdResult(el) {
  if (!el) return;
  const type = el.dataset.type;
  if (type === "note") { closeCmdBar(); openNote(el.dataset.path); }
  else if (type === "graph-node") { closeGraph(); closeCmdBar(); openNote(el.dataset.path); }
  else if (type === "cmd") {
    const cmd = CMD_ACTIONS.find(c => c.id === el.dataset.idx);
    if (cmd) { closeCmdBar(); cmd.action(); }
  }
  else if (type === "chat") {
    const question = el.dataset.question;
    if (!question) return;
    dom.cmdResultsInner.innerHTML = `<div class="cmd-chat-loading">Thinking</div>`;
    dom.cmdBar.classList.add("expanded");
    try {
      const context = { searchQuery: question };
      if (state.currentNotePath) context.notePath = state.currentNotePath;
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, context }),
      });
      const data = await chatRes.json();
      if (data.response) {
        const rendered = marked.parse(data.response);
        dom.cmdResultsInner.innerHTML = `<div class="cmd-chat-response">${rendered}</div><div class="cmd-hint">Press Esc to close</div>`;
        if (hljs) dom.cmdResultsInner.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
      } else {
        dom.cmdResultsInner.innerHTML = `<div class="cmd-chat-loading" style="animation:none">Failed: ${esc(data.error || "Unknown")}</div>`;
      }
    } catch (err) {
      dom.cmdResultsInner.innerHTML = `<div class="cmd-chat-loading" style="animation:none">Error: ${esc(err.message)}</div>`;
    }
  }
}

export function initCmdBar() {
  dom.cmdBar.addEventListener("click", e => { if (e.target === dom.cmdBar) closeCmdBar(); });
  dom.cmdInput.addEventListener("focus", () => renderCmdResults(dom.cmdInput.value));
  dom.cmdInput.addEventListener("input", () => { state.cmdSelectedIdx = 0; renderCmdResults(dom.cmdInput.value); });
  dom.cmdInput.addEventListener("keydown", e => {
    const items = dom.cmdResultsInner.querySelectorAll(".cmd-result");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.cmdSelectedIdx = Math.min(state.cmdSelectedIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("selected", i === state.cmdSelectedIdx));
      items[state.cmdSelectedIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      state.cmdSelectedIdx = Math.max(state.cmdSelectedIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle("selected", i === state.cmdSelectedIdx));
      items[state.cmdSelectedIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeCmdResult(items[state.cmdSelectedIdx]);
    } else if (e.key === "Escape") {
      closeCmdBar();
    }
  });
  dom.cmdResultsInner.addEventListener("click", e => {
    const result = e.target.closest(".cmd-result");
    if (result) executeCmdResult(result);
  });
  // Click outside the cmd bar collapses its results (but keeps it open in case the
  // user wants to keep typing).
  document.addEventListener("mousedown", e => {
    if (state.cmdBarOpen && !e.target.closest(".cmd-bar")) dom.cmdBar.classList.remove("expanded");
  });
}
