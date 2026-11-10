import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function binaryAvailable(command) {
  if (!command) return { available: false, path: null };
  if (command.includes("/") || command.startsWith(".")) {
    try { return { available: fs.existsSync(command), path: command }; } catch { return { available: false, path: command }; }
  }
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return { available: result.status === 0, path: result.status === 0 ? result.stdout.trim() : null };
}

export function getProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21] ?? null; } catch { return null; }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function terminateProcessTree(pid, { gracePeriodMs = 5000, pollIntervalMs = 50, identity = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { delivered: false, method: "none", escalated: false };
  if (identity && getProcessIdentity(pid) && identity !== getProcessIdentity(pid)) {
    return { delivered: false, method: "identity-mismatch", escalated: false };
  }
  const target = process.platform === "win32" ? pid : -pid;
  let delivered = false;
  try { process.kill(target, "SIGTERM"); delivered = true; } catch { try { process.kill(pid, "SIGTERM"); delivered = true; } catch {} }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  let escalated = false;
  if (isProcessAlive(pid)) {
    try { process.kill(target, "SIGKILL"); escalated = true; } catch { try { process.kill(pid, "SIGKILL"); escalated = true; } catch {} }
  }
  return { delivered, method: process.platform === "win32" ? "process" : "process-group", escalated };
}
