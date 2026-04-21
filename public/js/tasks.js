import { state } from "./state.js";
import { escapeHtml, formatTimeAgo, formatDuration } from "./helpers.js";
import { loadNotesTree } from "./notes/browser.js";

// Task board — queued / running / completed Claude Code tasks. Also surfaces cron
// jobs inline. All mutations go through /api/tasks and /api/cron; state updates
// stream in via WebSocket events dispatched by ws.js.

export async function loadTasks() {
  try {
    const [tasksRes, cronRes, autoRes] = await Promise.all([
      fetch("/api/tasks"),
      fetch("/api/cron"),
      fetch("/api/tasks/auto-execute"),
    ]);
    if (tasksRes.ok) state.tasksList = await tasksRes.json();
    if (cronRes.ok) state.tasksCronJobs = await cronRes.json();
    if (autoRes.ok) { const a = await autoRes.json(); state.taskAutoExecute = !!a.enabled; }
    renderTasks();
  } catch (err) { console.error("Failed to load tasks:", err); }
}

// --- WS event handlers — called from ws.js ---

export function taskHandleCreated(task) {
  if (!task) return;
  const idx = state.tasksList.findIndex(t => t.id === task.id);
  if (idx >= 0) state.tasksList[idx] = task;
  else state.tasksList.push(task);
  renderTasks();
  updateTaskBadge();
}

export function taskHandleStarted(task) {
  if (!task) return;
  const idx = state.tasksList.findIndex(t => t.id === task.id);
  if (idx >= 0) state.tasksList[idx] = task;
  else state.tasksList.push(task);
  state.taskOutputStreams[task.id] = { raw: task.output || "", html: "" };
  // Auto-open detail view for the running task
  state.taskDetailId = task.id;
  renderTasks();
  updateTaskBadge();
}

// Parse Claude Code's stream-json output into readable activity log entries
// (tool calls → "$ command", text blocks, results).
function parseStreamJsonChunk(raw) {
  const lines = raw.split("\n").filter(l => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "tool_use") {
            const name = block.name || "tool";
            const input = block.input || {};
            let desc = "";
            if (name === "Bash" || name === "bash") desc = `$ ${(input.command || "").slice(0, 200)}`;
            else if (name === "Read" || name === "read") desc = `Reading ${input.file_path || input.path || ""}`;
            else if (name === "Write" || name === "write") desc = `Writing ${input.file_path || input.path || ""}`;
            else if (name === "Edit" || name === "edit") desc = `Editing ${input.file_path || input.path || ""}`;
            else if (name === "Glob" || name === "glob") desc = `Finding ${input.pattern || ""}`;
            else if (name === "Grep" || name === "grep") desc = `Searching for "${input.pattern || ""}"`;
            else if (name === "WebSearch") desc = `Searching web: "${input.query || ""}"`;
            else if (name === "WebFetch") desc = `Fetching ${input.url || ""}`;
            else desc = `${name}(${JSON.stringify(input).slice(0, 150)})`;
            entries.push({ type: "tool", name, desc });
          } else if (block.type === "text" && block.text) {
            entries.push({ type: "text", text: block.text });
          }
        }
      } else if (ev.type === "content_block_delta" && ev.delta?.text) {
        entries.push({ type: "text-delta", text: ev.delta.text });
      } else if (ev.type === "result") {
        if (ev.result) entries.push({ type: "result", text: ev.result.slice(0, 2000) });
      }
    } catch {
      // Not JSON — show as raw text
      if (line.trim()) entries.push({ type: "raw", text: line });
    }
  }
  return entries;
}

export function taskHandleOutput(data) {
  if (!data || !data.id) return;
  if (!state.taskOutputStreams[data.id]) state.taskOutputStreams[data.id] = { raw: "", html: "" };
  const stream = state.taskOutputStreams[data.id];
  stream.raw += (data.data || "");

  const entries = parseStreamJsonChunk(data.data || "");
  let newHtml = "";
  for (const e of entries) {
    if (e.type === "tool") newHtml += `<div class="task-log-tool"><span class="task-log-tool-name">${escapeHtml(e.name)}</span> ${escapeHtml(e.desc)}</div>`;
    else if (e.type === "text") newHtml += `<div class="task-log-text">${escapeHtml(e.text)}</div>`;
    else if (e.type === "text-delta") newHtml += escapeHtml(e.text);
    else if (e.type === "result") newHtml += `<div class="task-log-result">${escapeHtml(e.text)}</div>`;
    else if (e.type === "raw") newHtml += `<div class="task-log-raw">${escapeHtml(e.text)}</div>`;
  }
  stream.html += newHtml;

  // If the detail view for this task is open, append to its live output element
  const el = document.getElementById("task-output-stream");
  if (el && el.dataset.taskId === data.id) {
    el.innerHTML = stream.html;
    el.scrollTop = el.scrollHeight;
  }
  updateTaskBadge();
}

export function taskHandleFinished(data) {
  if (!data) return;
  const task = data.id ? data : null;
  if (task && task.state) {
    const idx = state.tasksList.findIndex(t => t.id === task.id);
    if (idx >= 0) state.tasksList[idx] = task;
    else state.tasksList.push(task);
  }
  renderTasks();
  updateTaskBadge();
  loadNotesTree(); // tasks may have modified files
}

function updateTaskBadge() {
  const pending = state.tasksList.filter(t => t.state === "pending").length;
  const running = state.tasksList.filter(t => t.state === "running").length;
  const count = pending + running;
  const tab = document.querySelector('.intel-tab[data-panel="tasks"]');
  if (!tab) return;
  let badge = tab.querySelector(".task-badge");
  if (count > 0) {
    if (!badge) { badge = document.createElement("span"); badge.className = "task-badge"; tab.appendChild(badge); }
    badge.textContent = count;
  } else if (badge) { badge.remove(); }
}

function cronHumanReadable(expr) {
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dom === "*" && mon === "*" && dow === "*") return `Daily at ${time}`;
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", "1-5": "Weekdays" };
    return `${days[dow] || dow} at ${time}`;
  }
  if (hour.startsWith("*/")) return `Every ${hour.slice(2)}h`;
  if (min.startsWith("*/")) return `Every ${min.slice(2)}min`;
  return expr;
}

// --- Rendering ---

export function renderTasks() {
  if (state.taskDetailId) {
    const task = state.tasksList.find(t => t.id === state.taskDetailId);
    if (task) { renderTaskDetail(task); return; }
    state.taskDetailId = null;
  }
  renderTaskList();
}

function renderTaskList() {
  const body = document.getElementById("tasks-body");
  const pending = state.tasksList.filter(t => t.state === "pending")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const running = state.tasksList.find(t => t.state === "running");
  const completed = state.tasksList.filter(t => t.state === "completed" || t.state === "failed" || t.state === "cancelled")
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 20);

  const hasContent = running || pending.length || state.tasksCronJobs.length || completed.length;

  const autoToggle = document.getElementById("auto-execute-toggle");
  if (autoToggle) autoToggle.checked = state.taskAutoExecute;

  let html = "";

  if (!hasContent) {
    body.innerHTML = `<div class="tasks-empty"><div class="tasks-empty-icon">&#x2610;</div><h3>No Tasks</h3><p>Tasks come from voice delegation, cron jobs, or manual creation.</p></div>`;
    updateTaskBadge();
    return;
  }

  if (running) {
    html += `<div class="tasks-section"><div class="tasks-section-title">Running</div>`;
    html += renderTaskCard(running, true);
    html += `</div>`;
  }

  if (pending.length) {
    html += `<div class="tasks-section"><div class="tasks-section-title">Queue (${pending.length})</div>`;
    pending.forEach(t => { html += renderTaskCard(t, false); });
    html += `</div>`;
  }

  if (state.tasksCronJobs.length) {
    html += `<div class="tasks-section"><div class="tasks-section-title">Scheduled Jobs</div>`;
    state.tasksCronJobs.forEach(j => {
      html += `<div class="cron-card">
        <button class="cron-enabled-toggle ${j.enabled ? "on" : ""}" onclick="toggleCronJob('${j.id}', ${!j.enabled})" title="${j.enabled ? "Disable" : "Enable"}"></button>
        <div class="cron-card-info">
          <div class="cron-card-name">${escapeHtml(j.name)}</div>
          <div class="cron-card-schedule">${cronHumanReadable(j.schedule)}${j.lastRunAt ? " \u2022 Last: " + formatTimeAgo(j.lastRunAt) : ""}</div>
        </div>
        <div class="cron-card-actions">
          <button onclick="triggerCronJob('${j.id}')" title="Run now">\u25B6</button>
          <button onclick="deleteCronJob('${j.id}')" title="Delete">\u2715</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  if (completed.length) {
    html += `<div class="tasks-section"><div class="tasks-section-title">History</div>`;
    completed.forEach(t => { html += renderTaskCard(t, false); });
    html += `</div>`;
  }

  body.innerHTML = html;
  updateTaskBadge();
}

function renderTaskCard(t, isRunning) {
  const sourceLabel = t.source === "voice" ? "Voice" : t.source === "cron" ? (t.sourceLabel || "Cron") : "Manual";
  const stateIcon = t.state === "running" ? '<span class="task-running-spinner"></span>'
    : t.state === "completed" ? '<span class="task-state-badge completed">\u2713</span>'
    : t.state === "failed" ? '<span class="task-state-badge failed">\u2717</span>'
    : t.state === "cancelled" ? '<span class="task-state-badge cancelled">\u2014</span>' : "";
  const time = isRunning ? `Started ${formatTimeAgo(t.startedAt)} (${formatDuration(t.startedAt)})`
    : t.state === "pending" ? `Queued ${formatTimeAgo(t.createdAt)}`
    : `${formatDuration(t.startedAt, t.completedAt)} \u2022 ${formatTimeAgo(t.completedAt)}`;
  const modelLabel = t.model ? `<span class="task-model-badge">${escapeHtml(t.model)}</span>` : "";

  return `<div class="task-card ${isRunning ? "running" : ""}" onclick="openTaskDetail('${t.id}')">
    <div class="task-card-header">
      <div class="task-card-prompt">${stateIcon}${escapeHtml(t.prompt)}</div>
      <svg class="task-card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
    <div class="task-card-meta">
      <span class="task-source-badge ${t.source}">${sourceLabel}</span>
      ${modelLabel}
      <span>${time}</span>
      ${t.priority < 100 ? '<span style="color:var(--amber)">High</span>' : ""}
      ${t.error ? '<span style="color:var(--red)">' + escapeHtml(t.error.slice(0, 60)) + "</span>" : ""}
    </div>
  </div>`;
}

function renderTaskDetail(task) {
  const body = document.getElementById("tasks-body");
  const sourceLabel = task.source === "voice" ? "Voice" : task.source === "cron" ? (task.sourceLabel || "Cron") : "Manual";
  const isPending = task.state === "pending";
  const isRunning = task.state === "running";
  const isFinished = task.state === "completed" || task.state === "failed" || task.state === "cancelled";
  const stream = state.taskOutputStreams[task.id];
  const output = stream?.raw || task.output || "";

  let html = `<div class="task-detail">`;
  html += `<div class="task-detail-back" onclick="closeTaskDetail()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>
    Back to tasks
  </div>`;

  const stateLabel = isRunning ? '<span class="task-detail-state running"><span class="task-running-spinner"></span>Running</span>'
    : isPending ? '<span class="task-detail-state pending">Pending</span>'
    : task.state === "completed" ? '<span class="task-detail-state completed">\u2713 Completed</span>'
    : task.state === "failed" ? '<span class="task-detail-state failed">\u2717 Failed</span>'
    : '<span class="task-detail-state cancelled">\u2014 Cancelled</span>';
  html += `<div class="task-detail-header">${stateLabel}<span class="task-source-badge ${task.source}">${sourceLabel}</span></div>`;

  if (isPending) {
    // Editable prompt + model selector + save/execute/delete actions
    html += `<div class="task-detail-section">
      <div class="task-detail-label">Prompt</div>
      <textarea class="task-detail-prompt-edit" id="task-detail-prompt" rows="5">${escapeHtml(task.prompt)}</textarea>
    </div>`;
    html += `<div class="task-detail-section">
      <div class="task-detail-label">Model</div>
      <div class="task-detail-models">
        <button class="model-chip ${!task.model || task.model === 'sonnet' ? 'active' : ''}" onclick="setTaskModel('${task.id}','sonnet')">Sonnet</button>
        <button class="model-chip ${task.model === 'opus' ? 'active' : ''}" onclick="setTaskModel('${task.id}','opus')">Opus</button>
        <button class="model-chip ${task.model === 'haiku' ? 'active' : ''}" onclick="setTaskModel('${task.id}','haiku')">Haiku</button>
      </div>
    </div>`;
    html += `<div class="task-detail-actions">
      <button class="btn btn-accent btn-sm" onclick="saveTaskEdits('${task.id}')">Save Changes</button>
      <button class="btn btn-ghost btn-sm" onclick="executeThisTask('${task.id}')">Execute Now</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="cancelPendingTask('${task.id}'); closeTaskDetail();">Delete</button>
    </div>`;
  } else {
    html += `<div class="task-detail-section">
      <div class="task-detail-label">Prompt</div>
      <div class="task-detail-prompt-ro">${escapeHtml(task.prompt)}</div>
    </div>`;
    if (task.model) {
      html += `<div class="task-detail-section"><div class="task-detail-label">Model</div><span class="task-model-badge">${escapeHtml(task.model)}</span></div>`;
    }
  }

  html += `<div class="task-detail-meta">`;
  if (task.createdAt) html += `<div>Created: ${new Date(task.createdAt).toLocaleString()}</div>`;
  if (task.startedAt) html += `<div>Started: ${new Date(task.startedAt).toLocaleString()}</div>`;
  if (task.completedAt) html += `<div>Finished: ${new Date(task.completedAt).toLocaleString()} (${formatDuration(task.startedAt, task.completedAt)})</div>`;
  if (task.error) html += `<div style="color:var(--red)">Error: ${escapeHtml(task.error)}</div>`;
  html += `</div>`;

  if (isRunning || (isFinished && output)) {
    const displayHtml = stream?.html || "";
    const content = displayHtml || escapeHtml(output);
    html += `<div class="task-detail-section">
      <div class="task-detail-label">${isRunning ? "Live Output" : "Output"}</div>
      <div class="task-detail-output ${isRunning ? "live" : ""}" id="task-output-stream" data-task-id="${task.id}">${content}</div>
    </div>`;
  }

  if (isFinished) {
    html += `<div class="task-detail-actions">
      <button class="btn btn-accent btn-sm" onclick="retryTask('${task.id}'); closeTaskDetail();">Retry</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteTask('${task.id}'); closeTaskDetail();">Delete</button>
    </div>`;
  }
  if (isRunning) {
    html += `<div class="task-detail-actions">
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="cancelRunningTask('${task.id}')">Cancel Task</button>
    </div>`;
  }

  html += `</div>`;
  body.innerHTML = html;

  const outEl = document.getElementById("task-output-stream");
  if (outEl) outEl.scrollTop = outEl.scrollHeight;
}

function openTaskDetail(id) { state.taskDetailId = id; renderTasks(); }
function closeTaskDetail() { state.taskDetailId = null; renderTasks(); }

async function saveTaskEdits(id) {
  const promptEl = document.getElementById("task-detail-prompt");
  if (!promptEl) return;
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const task = state.tasksList.find(t => t.id === id);
  const model = task?.model || "sonnet";
  try {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model }),
    });
    if (res.ok) {
      const updated = await res.json();
      const idx = state.tasksList.findIndex(t => t.id === id);
      if (idx >= 0) state.tasksList[idx] = updated;
    }
  } catch {}
  renderTasks();
}

async function setTaskModel(id, model) {
  const task = state.tasksList.find(t => t.id === id);
  if (task) task.model = model;
  try {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
  } catch {}
  renderTasks();
}

async function executeThisTask(id) {
  // Jump to front of queue then execute immediately
  try {
    await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: 1 }),
    });
    await fetch("/api/tasks/execute-next", { method: "POST" });
  } catch {}
  loadTasks();
}

async function cancelRunningTask(id) { try { await fetch(`/api/tasks/${id}/cancel`, { method: "POST" }); } catch {} loadTasks(); }
async function cancelPendingTask(id) { try { await fetch(`/api/tasks/${id}/cancel`, { method: "POST" }); } catch {} loadTasks(); }
async function retryTask(id) { try { await fetch(`/api/tasks/${id}/retry`, { method: "POST" }); } catch {} loadTasks(); }
async function deleteTask(id) { try { await fetch(`/api/tasks/${id}`, { method: "DELETE" }); } catch {} loadTasks(); }
async function executeNextTask() { try { await fetch("/api/tasks/execute-next", { method: "POST" }); } catch {} loadTasks(); }
async function toggleAutoExecute(enabled) {
  state.taskAutoExecute = enabled;
  try {
    await fetch("/api/tasks/auto-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch {}
}
async function toggleCronJob(id, enabled) {
  try {
    await fetch(`/api/cron/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch {}
  loadTasks();
}
async function triggerCronJob(id) { try { await fetch(`/api/cron/${id}/trigger`, { method: "POST" }); } catch {} loadTasks(); }
async function deleteCronJob(id) { try { await fetch(`/api/cron/${id}`, { method: "DELETE" }); } catch {} loadTasks(); }

async function submitNewTask() {
  const input = document.getElementById("task-add-input");
  const prompt = input.value.trim();
  if (!prompt) return;
  try {
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {}
  input.value = "";
  document.getElementById("task-add-form").style.display = "none";
  loadTasks();
}

// Expose task actions to the global scope — the task board uses inline onclick
// attributes (for brevity in renderTaskCard templates) which module scope blocks.
window.cancelRunningTask = cancelRunningTask;
window.cancelPendingTask = cancelPendingTask;
window.retryTask = retryTask;
window.deleteTask = deleteTask;
window.toggleCronJob = toggleCronJob;
window.triggerCronJob = triggerCronJob;
window.deleteCronJob = deleteCronJob;
window.openTaskDetail = openTaskDetail;
window.closeTaskDetail = closeTaskDetail;
window.saveTaskEdits = saveTaskEdits;
window.setTaskModel = setTaskModel;
window.executeThisTask = executeThisTask;

export function initTasks() {
  document.getElementById("task-execute-btn")?.addEventListener("click", executeNextTask);
  document.getElementById("task-add-btn")?.addEventListener("click", () => {
    const form = document.getElementById("task-add-form");
    form.style.display = form.style.display === "none" ? "block" : "none";
    if (form.style.display === "block") document.getElementById("task-add-input").focus();
  });
  document.getElementById("task-add-submit")?.addEventListener("click", submitNewTask);
  document.getElementById("task-add-cancel")?.addEventListener("click", () => {
    document.getElementById("task-add-form").style.display = "none";
    document.getElementById("task-add-input").value = "";
  });
  document.getElementById("task-add-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitNewTask();
  });
  document.getElementById("auto-execute-toggle")?.addEventListener("change", e => toggleAutoExecute(e.target.checked));
}
