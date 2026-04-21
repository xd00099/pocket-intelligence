import express, { Router } from "express";
import * as TaskQueue from "../lib/task-queue.js";
import * as WorkerPty from "../lib/worker-pty.js";
import * as CronScheduler from "../lib/cron-scheduler.js";
import { requireAuth } from "../auth.js";
import { broadcastTaskEvent, getAutoExecuteEnabled, setAutoExecuteEnabled, tryExecuteNext } from "../task-events.js";

// /api/tasks/* and /api/cron/* routes. Both accept session cookies OR the internal
// X-Internal-Token header — so Claude Code running on the server can call these
// endpoints on behalf of the user.
export function buildTasksRouter(): Router {
  const r = Router();
  r.use("/api/tasks", requireAuth);
  r.use("/api/cron", requireAuth);

  // --- Task endpoints ---

  r.get("/api/tasks", (_req, res) => {
    res.json(TaskQueue.getAllTasks());
  });

  r.post("/api/tasks", express.json(), (req, res) => {
    const { prompt, timeoutMs, priority, model } = req.body;
    if (!prompt || !prompt.trim()) { res.status(400).json({ error: "Missing prompt" }); return; }
    const task = TaskQueue.addTask({ prompt: prompt.trim(), source: "manual", sourceLabel: "Manual", timeoutMs, priority, model });
    broadcastTaskEvent("task:created", task);
    if (getAutoExecuteEnabled()) tryExecuteNext();
    res.json(task);
  });

  r.post("/api/tasks/:id/cancel", (req, res) => {
    const task = TaskQueue.getTask(req.params.id);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    if (task.state === "running") {
      WorkerPty.cancel();
      TaskQueue.updateTask(task.id, { state: "cancelled", completedAt: Date.now() });
      broadcastTaskEvent("task:cancelled", TaskQueue.getTask(task.id));
    } else if (task.state === "pending") {
      TaskQueue.cancelTask(task.id);
      broadcastTaskEvent("task:cancelled", TaskQueue.getTask(task.id));
    } else {
      res.status(400).json({ error: "Cannot cancel task in state: " + task.state }); return;
    }
    res.json({ ok: true });
  });

  r.post("/api/tasks/:id/retry", (req, res) => {
    const old = TaskQueue.getTask(req.params.id);
    if (!old || (old.state !== "failed" && old.state !== "cancelled")) {
      res.status(400).json({ error: "Can only retry failed/cancelled tasks" }); return;
    }
    const task = TaskQueue.addTask({ prompt: old.prompt, source: old.source, sourceLabel: old.sourceLabel, timeoutMs: old.timeoutMs, priority: old.priority, cronJobId: old.cronJobId });
    broadcastTaskEvent("task:created", task);
    if (getAutoExecuteEnabled()) tryExecuteNext();
    res.json(task);
  });

  r.post("/api/tasks/execute-next", (_req, res) => {
    if (WorkerPty.isRunning()) { res.json({ ok: false, reason: "A task is already running" }); return; }
    const next = TaskQueue.nextPending();
    if (!next) { res.json({ ok: false, reason: "No pending tasks" }); return; }
    tryExecuteNext();
    res.json({ ok: true, taskId: next.id });
  });

  r.get("/api/tasks/auto-execute", (_req, res) => {
    res.json({ enabled: getAutoExecuteEnabled() });
  });

  r.post("/api/tasks/auto-execute", express.json(), (req, res) => {
    const enabled = !!req.body.enabled;
    setAutoExecuteEnabled(enabled);
    broadcastTaskEvent("auto-execute:changed", { enabled });
    if (enabled) tryExecuteNext();
    res.json({ enabled });
  });

  r.put("/api/tasks/:id", express.json(), (req, res) => {
    const task = TaskQueue.getTask(req.params.id);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }
    if (task.state !== "pending") { res.status(400).json({ error: "Can only edit pending tasks" }); return; }
    const updates: Partial<{ prompt: string; model: string; priority: number; timeoutMs: number }> = {};
    if (req.body.prompt !== undefined) updates.prompt = req.body.prompt;
    if (req.body.model !== undefined) updates.model = req.body.model;
    if (req.body.priority !== undefined) updates.priority = req.body.priority;
    if (req.body.timeoutMs !== undefined) updates.timeoutMs = req.body.timeoutMs;
    const updated = TaskQueue.updateTask(task.id, updates);
    broadcastTaskEvent("task:updated", updated);
    res.json(updated);
  });

  r.delete("/api/tasks/:id", (req, res) => {
    if (TaskQueue.deleteTask(req.params.id)) res.json({ ok: true });
    else res.status(400).json({ error: "Cannot delete (running or not found)" });
  });

  // --- Cron endpoints ---

  r.get("/api/cron", (_req, res) => {
    res.json(CronScheduler.getAllJobs());
  });

  r.post("/api/cron", express.json(), (req, res) => {
    const { name, schedule, prompt, autoExecute, timeoutMs } = req.body;
    if (!name || !schedule || !prompt) { res.status(400).json({ error: "Missing name, schedule, or prompt" }); return; }
    if (!CronScheduler.validateSchedule(schedule)) { res.status(400).json({ error: "Invalid cron expression" }); return; }
    const job = CronScheduler.addJob({ name, schedule, prompt, autoExecute, timeoutMs });
    if (!job) { res.status(500).json({ error: "Failed to create cron job" }); return; }
    broadcastTaskEvent("cron:created", job);
    res.json(job);
  });

  r.put("/api/cron/:id", express.json(), (req, res) => {
    if (req.body.schedule && !CronScheduler.validateSchedule(req.body.schedule)) {
      res.status(400).json({ error: "Invalid cron expression" }); return;
    }
    const job = CronScheduler.updateJob(req.params.id, req.body);
    if (!job) { res.status(404).json({ error: "Cron job not found" }); return; }
    broadcastTaskEvent("cron:updated", job);
    res.json(job);
  });

  r.delete("/api/cron/:id", (req, res) => {
    if (CronScheduler.deleteJob(req.params.id)) {
      broadcastTaskEvent("cron:deleted", { id: req.params.id });
      res.json({ ok: true });
    } else { res.status(404).json({ error: "Cron job not found" }); }
  });

  r.post("/api/cron/:id/trigger", (req, res) => {
    const job = CronScheduler.triggerNow(req.params.id);
    if (!job) { res.status(404).json({ error: "Cron job not found" }); return; }
    res.json({ ok: true, jobId: job.id });
  });

  return r;
}
