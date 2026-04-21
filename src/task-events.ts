import { existsSync } from "fs";
import { join } from "path";
import * as TaskQueue from "./lib/task-queue.js";
import * as WorkerPty from "./lib/worker-pty.js";
import * as CronScheduler from "./lib/cron-scheduler.js";
import { broadcast } from "./core/connection.js";
import { WORKSPACE_DIR, NOTES_REPO, NOTES_DIR, CLAUDE_BIN } from "./config.js";

// Auto-execute toggle: when true the server pulls the next pending task off the queue
// as soon as the worker goes idle. Surfaces in the UI as a switch in the tasks tab.
let autoExecuteEnabled = false;
export function getAutoExecuteEnabled(): boolean { return autoExecuteEnabled; }
export function setAutoExecuteEnabled(v: boolean) { autoExecuteEnabled = v; }

// Event broadcaster — used by voice tool-executor, routes, cron scheduler.
// The `data` payload is a Task or CronJob in most cases; type stays loose because the
// consumer (`app.js`) picks off specific fields per event type.
export function broadcastTaskEvent(type: string, data: any) {
  broadcast(type, { data });
}

// Pull the next pending task off the queue and dispatch it to WorkerPty. No-op if the
// worker is already running or the queue is empty. Safe to call any time.
export function tryExecuteNext() {
  if (WorkerPty.isRunning()) return;
  const task = TaskQueue.nextPending();
  if (!task) return;
  TaskQueue.updateTask(task.id, { state: "running", startedAt: Date.now() });
  broadcastTaskEvent("task:started", TaskQueue.getTask(task.id));
  const cwd = NOTES_REPO && existsSync(NOTES_DIR) ? NOTES_DIR : WORKSPACE_DIR;
  WorkerPty.execute(task, CLAUDE_BIN, cwd);
}

// Wire up TaskQueue + WorkerPty + CronScheduler. Called once at startup (after the
// pty onboarding config is in place, so spawning a worker can find Claude Code).
export function initTaskAndCron() {
  TaskQueue.initTaskQueue(join(WORKSPACE_DIR, ".task-queue.json"));

  WorkerPty.setCallbacks({
    onOutput: (taskId, data) => {
      TaskQueue.appendOutput(taskId, data);
      broadcastTaskEvent("task:output", { id: taskId, data });
    },
    onComplete: (taskId, exitCode) => {
      TaskQueue.updateTask(taskId, {
        state: exitCode === 0 ? "completed" : "failed",
        completedAt: Date.now(),
        exitCode,
        error: exitCode !== 0 ? `Exited with code ${exitCode}` : undefined,
      });
      broadcastTaskEvent("task:completed", TaskQueue.getTask(taskId));
      TaskQueue.pruneCompleted();
      if (autoExecuteEnabled) setTimeout(tryExecuteNext, 1000);
    },
    onError: (taskId, error) => {
      TaskQueue.updateTask(taskId, { state: "failed", completedAt: Date.now(), error });
      broadcastTaskEvent("task:failed", TaskQueue.getTask(taskId));
      if (autoExecuteEnabled) setTimeout(tryExecuteNext, 1000);
    },
  });

  CronScheduler.initCronScheduler(join(WORKSPACE_DIR, ".cron-jobs.json"), (cronJob) => {
    const task = TaskQueue.addTask({
      prompt: cronJob.prompt,
      source: "cron",
      sourceLabel: cronJob.name,
      timeoutMs: cronJob.timeoutMs,
      cronJobId: cronJob.id,
    });
    CronScheduler.updateJob(cronJob.id, { lastRunAt: Date.now(), lastTaskId: task.id });
    broadcastTaskEvent("task:created", task);
    if (autoExecuteEnabled && cronJob.autoExecute) tryExecuteNext();
  });
}
