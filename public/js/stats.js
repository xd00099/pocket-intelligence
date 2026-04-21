import { ENV } from "./state.js";
import { esc } from "./helpers.js";
import { getStreak } from "./activity.js";
import { TOPIC_COLORS } from "./graph.js";

// Vault stats overlay: notes + word totals, streak grid, per-topic bars.
// Pulls from /api/notes/stats plus local activity log in localStorage.

export async function openStats() {
  const overlay = document.getElementById("stats-overlay");
  const body = document.getElementById("stats-body");
  overlay.classList.add("visible");
  body.innerHTML = '<div class="cmd-chat-loading">Loading stats</div>';
  try {
    const res = await fetch("/api/notes/stats");
    const stats = await res.json();
    const streak = getStreak();
    const activities = JSON.parse(localStorage.getItem(ENV.ACTIVITY_KEY) || "[]");
    const notesRead = new Set(activities.filter(a => a.type === "note").map(a => a.path)).size;
    const voiceSessions = activities.filter(a => a.type === "voice").length;

    // 30-day heatmap of study days
    let streakHtml = "";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today - i * 86400000).toISOString().slice(0, 10);
      streakHtml += `<div class="streak-day${streak.days.includes(d) ? " active" : ""}${i === 0 ? " today" : ""}" title="${d}"></div>`;
    }

    // Top 10 topics as horizontal bars
    const maxNotes = Math.max(1, ...stats.topics.map(t => t.notes));
    const topicHtml = stats.topics.slice(0, 10).map((t, i) =>
      `<div class="topic-bar"><span class="topic-name">${esc(t.name)}</span><div class="topic-bar-track"><div class="topic-bar-fill" style="width:${(t.notes / maxNotes * 100).toFixed(0)}%;background:${TOPIC_COLORS[i % TOPIC_COLORS.length]}"></div></div><span class="topic-count">${t.notes} notes</span></div>`
    ).join("");

    body.innerHTML = `<div class="stats-grid"><div class="stat-card stat-accent"><div class="stat-value">${stats.totalNotes}</div><div class="stat-label">Total Notes</div></div><div class="stat-card"><div class="stat-value">${(stats.totalWords / 1000).toFixed(1)}k</div><div class="stat-label">Words</div></div><div class="stat-card stat-green"><div class="stat-value">${streak.current}</div><div class="stat-label">Day Streak</div></div><div class="stat-card"><div class="stat-value">${notesRead}</div><div class="stat-label">Notes Read</div></div><div class="stat-card"><div class="stat-value">${voiceSessions}</div><div class="stat-label">Voice Sessions</div></div><div class="stat-card"><div class="stat-value">${stats.topics.length}</div><div class="stat-label">Topics</div></div></div><div class="streak-section"><div class="stats-section-title">Study Activity (30 days)</div><div class="streak-grid">${streakHtml}</div></div><div style="margin-top:24px"><div class="stats-section-title">Topics</div>${topicHtml}</div>`;
  } catch {
    body.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px">Failed to load stats</div>`;
  }
}

export function initStats() {
  document.getElementById("sidebar-stats-btn").addEventListener("click", openStats);
  document.getElementById("stats-close").addEventListener("click", () =>
    document.getElementById("stats-overlay").classList.remove("visible")
  );
}
