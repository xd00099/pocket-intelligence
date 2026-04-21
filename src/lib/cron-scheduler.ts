import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import cron from "node-cron";

export interface CronJob {
  id: string;
  name: string;
  schedule: string;       // cron expression e.g. "0 8 * * *"
  prompt: string;
  enabled: boolean;
  autoExecute: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastTaskId?: string;
  timeoutMs: number;
}

let jobs: CronJob[] = [];
let scheduled: Map<string, cron.ScheduledTask> = new Map();
let filePath = "";
let triggerCallback: (job: CronJob) => void = () => {};

export function initCronScheduler(path: string, onTrigger: (job: CronJob) => void) {
  filePath = path;
  triggerCallback = onTrigger;
  load();
  startAll();
}

function load() {
  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, "utf8"));
      jobs = Array.isArray(data.jobs) ? data.jobs : [];
      console.log(`Loaded ${jobs.length} cron jobs`);
    }
  } catch {
    console.warn("Could not load cron jobs, starting fresh");
    jobs = [];
  }
}

function save() {
  try {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ jobs }, null, 2));
    renameSync(tmp, filePath);
  } catch (err) {
    console.error("Failed to save cron jobs:", err);
  }
}

function scheduleJob(job: CronJob) {
  unscheduleJob(job.id);
  if (!job.enabled) return;
  if (!cron.validate(job.schedule)) {
    console.warn(`Invalid cron expression for job ${job.id}: ${job.schedule}`);
    return;
  }
  const task = cron.schedule(job.schedule, () => {
    console.log(`[Cron] Triggered: ${job.name} (${job.id})`);
    job.lastRunAt = Date.now();
    save();
    triggerCallback(job);
  });
  scheduled.set(job.id, task);
}

function unscheduleJob(id: string) {
  const existing = scheduled.get(id);
  if (existing) {
    existing.stop();
    scheduled.delete(id);
  }
}

function startAll() {
  for (const job of jobs) {
    if (job.enabled) scheduleJob(job);
  }
  console.log(`Started ${scheduled.size} cron jobs`);
}

export function stopAll() {
  for (const [id, task] of scheduled) {
    task.stop();
  }
  scheduled.clear();
}

export function addJob(opts: {
  name: string;
  schedule: string;
  prompt: string;
  autoExecute?: boolean;
  timeoutMs?: number;
}): CronJob | null {
  if (!cron.validate(opts.schedule)) return null;
  const job: CronJob = {
    id: randomUUID(),
    name: opts.name,
    schedule: opts.schedule,
    prompt: opts.prompt,
    enabled: true,
    autoExecute: opts.autoExecute !== false,
    createdAt: Date.now(),
    timeoutMs: opts.timeoutMs || 600_000,
  };
  jobs.push(job);
  save();
  scheduleJob(job);
  return job;
}

export function updateJob(id: string, updates: Partial<CronJob>): CronJob | undefined {
  const job = jobs.find(j => j.id === id);
  if (!job) return undefined;
  const wasEnabled = job.enabled;
  const oldSchedule = job.schedule;
  Object.assign(job, updates);
  save();
  // Reschedule if enabled/schedule changed
  if (job.enabled !== wasEnabled || job.schedule !== oldSchedule) {
    if (job.enabled) scheduleJob(job);
    else unscheduleJob(job.id);
  }
  return job;
}

export function deleteJob(id: string): boolean {
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return false;
  unscheduleJob(id);
  jobs.splice(idx, 1);
  save();
  return true;
}

export function enableJob(id: string): CronJob | undefined {
  const job = jobs.find(j => j.id === id);
  if (!job) return undefined;
  job.enabled = true;
  save();
  scheduleJob(job);
  return job;
}

export function disableJob(id: string): CronJob | undefined {
  const job = jobs.find(j => j.id === id);
  if (!job) return undefined;
  job.enabled = false;
  save();
  unscheduleJob(id);
  return job;
}

export function triggerNow(id: string): CronJob | undefined {
  const job = jobs.find(j => j.id === id);
  if (!job) return undefined;
  console.log(`[Cron] Manual trigger: ${job.name} (${job.id})`);
  job.lastRunAt = Date.now();
  save();
  triggerCallback(job);
  return job;
}

export function getJob(id: string): CronJob | undefined {
  return jobs.find(j => j.id === id);
}

export function getAllJobs(): CronJob[] {
  return [...jobs];
}

export function validateSchedule(schedule: string): boolean {
  return cron.validate(schedule);
}
