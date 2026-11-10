import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { binaryAvailable } from "./process.mjs";

export function locatePi(piBinary = process.env.PI_BIN || "pi") {
  return { binary: piBinary, ...binaryAvailable(piBinary) };
}

export function piVersion(piBinary = process.env.PI_BIN || "pi", env = process.env) {
  const located = locatePi(piBinary);
  if (!located.available) return { available: false, version: null, error: `pi binary not found: ${piBinary}` };
  const result = spawnSync(piBinary, ["--version"], { encoding: "utf8", env, timeout: 5000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { available: result.status === 0, version: output || null, error: result.status === 0 ? null : output || `pi exited ${result.status}` };
}

export function latestPiVersion({ npm = "npm", timeout = 5000 } = {}) {
  const result = spawnSync(npm, ["view", "@earendil-works/pi-coding-agent", "version", "--json"], { encoding: "utf8", timeout });
  if (result.status !== 0) return { version: null, error: `${result.stderr ?? ""}`.trim() || "npm view failed" };
  try { return { version: JSON.parse(result.stdout), error: null }; } catch { return { version: result.stdout.trim() || null, error: null }; }
}

export function buildPiArgs({ providerName, model, readOnly = false, thinking = null, trustProject = false } = {}) {
  if (!providerName || !model) throw new Error("providerName and model are required to build pi arguments.");
  const args = ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--model", `${providerName}/${model}`];
  if (readOnly) args.push("--tools", "read,grep,find,ls");
  else args.push("--tools", "read,edit,write,grep,find,ls");
  if (thinking) args.push("--thinking", thinking);
  args.push(trustProject ? "--approve" : "--no-approve");
  return args;
}

export function spawnPi({ piBinary = "pi", cwd, env = process.env, ...options } = {}) {
  const args = buildPiArgs(options);
  const child = spawn(piBinary, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  return { child, args };
}
