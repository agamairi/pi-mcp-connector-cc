import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function runGit(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function gitRoot(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function within(root, value) {
  const absolute = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path is outside the repository: ${value}`);
  return { absolute, relative: relative || "." };
}

export function validateDeclaredFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 5) throw new Error("files must contain 1 to 5 repository-relative paths.");
  const result = [];
  for (const file of files) {
    if (typeof file !== "string" || !file.trim() || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error(`Invalid declared file "${file}".`);
    const normalized = file.replaceAll("\\", "/");
    if (normalized === "." || normalized.endsWith("/")) throw new Error(`Declared path must be a file: "${file}".`);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

export function changedFiles(cwd, base = "HEAD") {
  const paths = new Set();
  const status = runGit(cwd, ["status", "--short", "--untracked-files=all"]);
  if (status.status === 0) {
    for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
      const value = line.slice(3).trim();
      if (value) paths.add(value.replace(/^.* -> /, ""));
    }
  }
  for (const args of [["diff", "--name-only", base], ["diff", "--cached", "--name-only", base]]) {
    const result = runGit(cwd, args);
    if (result.status === 0) for (const value of result.stdout.split(/\r?\n/).filter(Boolean)) paths.add(value.trim());
  }
  return [...paths].filter(Boolean).sort();
}

// Mark untracked files as intent-to-add inside a sandbox so new files appear in diffs.
// Only ever called with a sandbox cwd, never the user's working tree.
function markUntracked(cwd) {
  runGit(cwd, ["add", "-N", "--", "."]);
}

export function diffStat(cwd, base = "HEAD") {
  markUntracked(cwd);
  const result = runGit(cwd, ["diff", "--stat", base]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export function diffText(cwd, base = "HEAD") {
  markUntracked(cwd);
  const result = runGit(cwd, ["diff", base, "--binary"]);
  return result.status === 0 ? result.stdout : "";
}

export function createGitSandbox(repo, sandbox, branch, base = "HEAD") {
  fs.mkdirSync(path.dirname(sandbox), { recursive: true });
  const result = runGit(repo, ["worktree", "add", sandbox, "-b", branch, base]);
  if (result.status !== 0) throw new Error(`Unable to create git worktree: ${(result.stderr || result.stdout).trim()}`);
  return { sandbox, branch, base, git: true };
}

export function copyDeclaredFiles(repo, sandbox, files) {
  fs.mkdirSync(sandbox, { recursive: true });
  for (const file of files) {
    const source = within(repo, file).absolute;
    const destination = within(sandbox, file).absolute;
    if (!fs.existsSync(source)) continue;
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error(`Declared path is not a regular file: ${file}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { sandbox, branch: null, base: null, git: false };
}

export function createSandbox(repo, sandbox, jobId, files, base = null) {
  const root = gitRoot(repo);
  if (root) return createGitSandbox(root, sandbox, `pi/${jobId}`, base || "HEAD");
  return copyDeclaredFiles(repo, sandbox, files);
}

export function listSandboxFiles(root) {
  const result = [];
  function visit(dir, prefix = "") {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else result.push(relative);
    }
  }
  visit(root);
  return result.sort();
}

export function runVerify(command, cwd, timeoutMs = 20 * 60 * 1000) {
  const result = spawnSync("/bin/sh", ["-lc", command], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  const lines = output.split(/\r?\n/);
  return { command, exitCode: result.error?.code === "ETIMEDOUT" ? null : result.status, timedOut: result.error?.code === "ETIMEDOUT", output, tail: lines.slice(-40).join("\n") };
}

export function copyForTest(repo, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-connector-sandbox-"));
  return copyDeclaredFiles(repo, sandbox, files);
}
