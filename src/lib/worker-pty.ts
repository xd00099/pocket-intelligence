import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import type { Task } from "./task-queue.js";

let proc: ChildProcess | null = null;
let currentTaskId: string | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let watchdogHandle: ReturnType<typeof setInterval> | null = null;
let lastOutputTime = 0;
let aborted = false;

// Callbacks — wired up by the server
export let onOutput: (taskId: string, data: string) => void = () => {};
export let onComplete: (taskId: string, exitCode: number) => void = () => {};
export let onError: (taskId: string, error: string) => void = () => {};

export function setCallbacks(cbs: {
  onOutput: typeof onOutput;
  onComplete: typeof onComplete;
  onError: typeof onError;
}) {
  onOutput = cbs.onOutput;
  onComplete = cbs.onComplete;
  onError = cbs.onError;
}

export function isRunning(): boolean {
  return proc !== null && currentTaskId !== null;
}

export function getCurrentTaskId(): string | null {
  return currentTaskId;
}

function clearTimers() {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
  if (watchdogHandle) { clearInterval(watchdogHandle); watchdogHandle = null; }
}

export function execute(task: Task, claudeBin: string, cwd: string) {
  if (proc) {
    onError(task.id, "Worker is already running a task");
    return;
  }

  currentTaskId = task.id;
  lastOutputTime = Date.now();
  aborted = false;

  // Build args: -p for print mode, --output-format stream-json for real-time events
  // Tool permissions are auto-approved via ~/.claude/settings.json (created by ensureClaudeConfig)
  const args = ["-p", task.prompt, "--output-format", "stream-json", "--verbose"];
  if (task.model) args.push("--model", task.model);

  console.log(`[Worker] Executing task ${task.id}: ${task.prompt.slice(0, 100)}...`);
  console.log(`[Worker] Command: ${claudeBin} ${args.map(a => a.length > 60 ? a.slice(0, 60) + "..." : a).join(" ")}`);

  try {
    proc = spawn(claudeBin, args, {
      cwd: existsSync(cwd) ? cwd : process.cwd(),
      env: {
        ...process.env,
        HOME: process.env.HOME || "/workspace/.home",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    console.error("[Worker] Failed to spawn:", err);
    currentTaskId = null;
    onError(task.id, `Failed to spawn worker: ${err.message}`);
    return;
  }

  proc.stdout?.on("data", (data: Buffer) => {
    lastOutputTime = Date.now();
    onOutput(task.id, data.toString());
  });

  proc.stderr?.on("data", (data: Buffer) => {
    lastOutputTime = Date.now();
    onOutput(task.id, data.toString());
  });

  proc.on("error", (err) => {
    console.error("[Worker] Process error:", err);
    clearTimers();
    proc = null;
    const taskId = currentTaskId;
    currentTaskId = null;
    if (taskId && !aborted) onError(taskId, `Process error: ${err.message}`);
  });

  proc.on("exit", (code) => {
    console.log(`[Worker] Task ${task.id} exited with code ${code}`);
    clearTimers();
    proc = null;
    const taskId = currentTaskId;
    currentTaskId = null;
    if (taskId && !aborted) onComplete(taskId, code ?? 1);
  });

  // Timeout: kill after task.timeoutMs
  timeoutHandle = setTimeout(() => {
    if (proc && currentTaskId) {
      console.log(`[Worker] Task ${currentTaskId} timed out after ${task.timeoutMs}ms`);
      const taskId = currentTaskId;
      cleanup();
      onError(taskId, `Task timed out after ${Math.round(task.timeoutMs / 1000)}s`);
    }
  }, task.timeoutMs);

  // Watchdog: kill if no output for 10 minutes
  watchdogHandle = setInterval(() => {
    if (proc && currentTaskId && Date.now() - lastOutputTime > 600_000) {
      console.log(`[Worker] Task ${currentTaskId} stuck — no output for 10 minutes`);
      const taskId = currentTaskId;
      cleanup();
      onError(taskId, "Task appears stuck (no output for 10 minutes)");
    }
  }, 30_000);
}

function cleanup() {
  aborted = true;
  clearTimers();
  if (proc) {
    try { proc.kill("SIGTERM"); } catch {}
    // Force kill after 3s if still alive
    const p = proc;
    setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000);
    proc = null;
  }
  currentTaskId = null;
}

export function cancel(): string | null {
  if (!proc || !currentTaskId) return null;
  const taskId = currentTaskId;
  console.log(`[Worker] Cancelling task ${taskId}`);
  cleanup();
  return taskId;
}
