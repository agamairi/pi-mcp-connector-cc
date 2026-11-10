import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProcessIdentity, isProcessAlive, terminateProcessTree } from "./process.mjs";

export const TERMINAL_STATUSES = new Set(["completed", "failed", "incomplete", "needs_review", "canceled", "interrupted"]);
export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export function stateRoot(env = process.env) {
  return env.PI_CONNECTOR_STATE_DIR || path.join(os.homedir(), ".local", "state", "pi-connector");
}

export function workspaceHash(cwd) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch {}
  return crypto.createHash("sha256").update(path.resolve(real)).digest("hex").slice(0, 16);
}

export function resolveJobsDir(cwd, env = process.env) {
  return path.join(stateRoot(env), "jobs", workspaceHash(cwd));
}

export function resolveJobFile(cwd, id, env = process.env) {
  return path.join(resolveJobsDir(cwd, env), `${id}.json`);
}

export function resolveSandboxRoot(cwd, env = process.env) {
  return path.join(resolveJobsDir(cwd, env), "sandboxes");
}

export function writeJob(cwd, job, env = process.env) {
  const dir = resolveJobsDir(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = resolveJobFile(cwd, job.id, env);
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return file;
}

export function readJob(cwd, id, env = process.env) {
  try { return JSON.parse(fs.readFileSync(resolveJobFile(cwd, id, env), "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function listJobs(cwd, env = process.env) {
  const dir = resolveJobsDir(cwd, env);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function generateJobId(prefix = "job") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createJobRecord({ id, kind, cwd, model, endpoint, write = false, files = [], successCriteria = null, verifyCommand = null, maxToolCalls = 20 }) {
  const now = new Date().toISOString();
  return {
    id, kind, cwd, model, endpoint, write, files, successCriteria, verifyCommand, maxToolCalls,
    status: "queued", phase: "queued", createdAt: now, updatedAt: now, startedAt: null, completedAt: null,
    pid: null, pidIdentity: null, sessionId: null, sandboxPath: null, branch: null, base: null,
    context: null, contextWarning: null, toolCalls: 0, durationMs: null, finalText: "", usage: null,
    modelClaim: null, changedFiles: [], scope: "not checked", diffStat: "", verify: null, error: null,
    failureKind: null, log: [],
  };
}

function patchJob(cwd, job, patch, env) {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  writeJob(cwd, next, env);
  return next;
}

export function reconcileJobs(cwd, { activeIds = new Set(), env = process.env, now = Date.now } = {}) {
  const result = [];
  for (const job of listJobs(cwd, env)) {
    if (!ACTIVE_STATUSES.has(job.status) || activeIds.has(job.id)) { result.push(job); continue; }
    if (!job.pid) {
      result.push(patchJob(cwd, job, { status: "interrupted", phase: "interrupted", completedAt: new Date(now()).toISOString(), error: "Job exited without reporting a process ID." }, env));
      continue;
    }
    if (!isProcessAlive(job.pid)) {
      result.push(patchJob(cwd, job, { status: "interrupted", phase: "interrupted", pid: null, completedAt: new Date(now()).toISOString(), error: "Job process is no longer running." }, env));
      continue;
    }
    if (job.pidIdentity && getProcessIdentity(job.pid) && job.pidIdentity !== getProcessIdentity(job.pid)) {
      result.push(patchJob(cwd, job, { status: "interrupted", phase: "interrupted", pid: null, completedAt: new Date(now()).toISOString(), error: "PID was reused by another process; it was not signalled." }, env));
      continue;
    }
    result.push(job);
  }
  return result.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function resolveJob(cwd, id, { activeIds = new Set(), env = process.env } = {}) {
  const jobs = reconcileJobs(cwd, { activeIds, env });
  if (id) {
    const exact = jobs.find((job) => job.id === id);
    if (exact) return exact;
    const matches = jobs.filter((job) => job.id.startsWith(id));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Job reference "${id}" is ambiguous.`);
    throw new Error(`No job found for "${id}".`);
  }
  return jobs[0] ?? null;
}

export async function cancelJob(cwd, job, { active = null, env = process.env } = {}) {
  if (!job || !ACTIVE_STATUSES.has(job.status)) throw new Error("No active job found.");
  if (active?.child?.pid) await terminateProcessTree(active.child.pid, { identity: job.pidIdentity });
  else if (job.pid) await terminateProcessTree(job.pid, { identity: job.pidIdentity });
  return patchJob(cwd, job, { status: "canceled", phase: "canceled", completedAt: new Date().toISOString(), error: "Canceled by caller." }, env);
}

export function formatDuration(ms) {
  const value = Math.max(0, Math.floor(Number(ms) / 1000));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${value % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
