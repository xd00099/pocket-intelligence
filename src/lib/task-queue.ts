import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { randomUUID } from "crypto";

export interface Task {
  id: string;
  prompt: string;
  model?: string;  // Claude model to use (e.g. "sonnet", "opus", "haiku")
  source: "voice" | "cron" | "manual";
  sourceLabel?: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  output: string;
  exitCode?: number;
  error?: string;
  timeoutMs: number;
  priority: number;
  cronJobId?: string;
}

const MAX_COMPLETED = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB

let tasks: Task[] = [];
let filePath = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function initTaskQueue(path: string) {
  filePath = path;
  load();
  // Recover any tasks that were "running" when server crashed
  for (const t of tasks) {
    if (t.state === "running") {
      t.state = "failed";
      t.completedAt = Date.now();
      t.error = "Server restarted while task was running";
    }
  }
  save();
}

function load() {
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      tasks = Array.isArray(data.tasks) ? data.tasks : [];
      console.log(`Loaded ${tasks.length} tasks from queue`);
    }
  } catch {
    console.warn("Could not load task queue, starting fresh");
    tasks = [];
  }
}

export function save() {
  if (saveTimer) return; // debounced save already pending
  saveTimer = setTimeout(flushSave, 500);
}

export function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ tasks }, null, 2));
    renameSync(tmp, filePath);
  } catch (err) {
    console.error("Failed to save task queue:", err);
  }
}

export function addTask(opts: {
  prompt: string;
  source: Task["source"];
  sourceLabel?: string;
  model?: string;
  timeoutMs?: number;
  priority?: number;
  cronJobId?: string;
}): Task {
  const task: Task = {
    id: randomUUID(),
    prompt: opts.prompt,
    model: opts.model,
    source: opts.source,
    sourceLabel: opts.sourceLabel,
    state: "pending",
    createdAt: Date.now(),
    output: "",
    timeoutMs: opts.timeoutMs || 900_000, // 15 min default
    priority: opts.priority ?? 100,
    cronJobId: opts.cronJobId,
  };
  tasks.push(task);
  save();
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.find(t => t.id === id);
}

export function updateTask(id: string, updates: Partial<Task>): Task | undefined {
  const task = tasks.find(t => t.id === id);
  if (!task) return undefined;
  Object.assign(task, updates);
  // Cap output size
  if (task.output.length > MAX_OUTPUT_BYTES) {
    task.output = task.output.slice(0, MAX_OUTPUT_BYTES) + "\n\n[output truncated at 2MB]";
  }
  save();
  return task;
}

export function appendOutput(id: string, data: string): Task | undefined {
  const task = tasks.find(t => t.id === id);
  if (!task) return undefined;
  if (task.output.length < MAX_OUTPUT_BYTES) {
    task.output += data;
    if (task.output.length > MAX_OUTPUT_BYTES) {
      task.output = task.output.slice(0, MAX_OUTPUT_BYTES) + "\n\n[output truncated at 2MB]";
    }
  }
  save();
  return task;
}

export function cancelTask(id: string): boolean {
  const task = tasks.find(t => t.id === id);
  if (!task || (task.state !== "pending" && task.state !== "running")) return false;
  task.state = "cancelled";
  task.completedAt = Date.now();
  save();
  return true;
}

export function deleteTask(id: string): boolean {
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  const task = tasks[idx];
  if (task.state === "running") return false; // can't delete running
  tasks.splice(idx, 1);
  save();
  return true;
}

export function nextPending(): Task | undefined {
  return tasks
    .filter(t => t.state === "pending")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)[0];
}

export function getRunning(): Task | undefined {
  return tasks.find(t => t.state === "running");
}

export function getPending(): Task[] {
  return tasks
    .filter(t => t.state === "pending")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

export function getCompleted(): Task[] {
  return tasks
    .filter(t => t.state === "completed" || t.state === "failed" || t.state === "cancelled")
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
}

export function getAllTasks(): Task[] {
  return [...tasks];
}

export function pruneCompleted() {
  const completed = getCompleted();
  if (completed.length > MAX_COMPLETED) {
    const toRemove = new Set(completed.slice(MAX_COMPLETED).map(t => t.id));
    tasks = tasks.filter(t => !toRemove.has(t.id));
    save();
  }
}
