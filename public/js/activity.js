import { ENV } from "./state.js";

// Activity log + study streak — persisted in localStorage so it survives page reloads
// without needing a backend round-trip. The streak counts consecutive days with at
// least one note/voice interaction.

export function logActivity(type, title, data = {}) {
  try {
    const activities = JSON.parse(localStorage.getItem(ENV.ACTIVITY_KEY) || "[]");
    // Dedupe: collapse repeated same-activity entries within 60 s to avoid noise from
    // rapid back-and-forth navigation.
    if (activities.length > 0 && activities[0].type === type && activities[0].title === title
        && Date.now() - activities[0].timestamp < 60000) return;
    activities.unshift({ type, title, timestamp: Date.now(), ...data });
    if (activities.length > ENV.MAX_ACTIVITIES) activities.length = ENV.MAX_ACTIVITIES;
    localStorage.setItem(ENV.ACTIVITY_KEY, JSON.stringify(activities));
    // Note or voice activity counts as a study day for the streak.
    if (type === "note" || type === "voice") recordStudyDay();
  } catch {}
}

function recordStudyDay() {
  try {
    const days = JSON.parse(localStorage.getItem(ENV.STREAK_KEY) || "[]");
    const today = new Date().toISOString().slice(0, 10);
    if (!days.includes(today)) {
      days.push(today);
      if (days.length > 90) days.shift();
      localStorage.setItem(ENV.STREAK_KEY, JSON.stringify(days));
    }
  } catch {}
}

// Current streak = consecutive days ending today with an entry. Capped at 60 days
// back to keep the loop cheap.
export function getStreak() {
  try {
    const days = JSON.parse(localStorage.getItem(ENV.STREAK_KEY) || "[]").sort();
    if (!days.length) return { current: 0, total: 0, days };
    let streak = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 60; i++) {
      const d = new Date(today - i * 86400000).toISOString().slice(0, 10);
      if (days.includes(d)) streak++;
      else if (i > 0) break;
    }
    return { current: streak, total: days.length, days };
  } catch {
    return { current: 0, total: 0, days: [] };
  }
}
