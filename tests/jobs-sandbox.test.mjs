import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createSandbox, changedFiles, gitRoot, runVerify } from "../lib/git.mjs";
import { makeTempDir, initGitRepo, commitAll, run } from "./helpers.mjs";
import { createJobRecord, reconcileJobs, resolveJobsDir, writeJob } from "../lib/jobs.mjs";

test("creates a worktree from HEAD and leaves the user's working tree untouched", () => {
  const repo = makeTempDir();
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  initGitRepo(repo); commitAll(repo);
  const state = makeTempDir();
  const sandbox = path.join(state, "sandboxes", "job-1");
  const result = createSandbox(repo, sandbox, "job-1", ["tracked.txt"]);
  fs.writeFileSync(path.join(sandbox, "tracked.txt"), "changed\n");
  assert.equal(fs.readFileSync(path.join(repo, "tracked.txt"), "utf8"), "base\n");
  assert.equal(fs.realpathSync(gitRoot(repo)), fs.realpathSync(repo));
  assert.deepEqual(changedFiles(sandbox, result.base), ["tracked.txt"]);
});

test("non-git sandbox copies only declared files", () => {
  const repo = makeTempDir();
  fs.writeFileSync(path.join(repo, "a.txt"), "a");
  fs.writeFileSync(path.join(repo, "b.txt"), "b");
  const sandbox = path.join(makeTempDir(), "copy");
  createSandbox(repo, sandbox, "job-2", ["a.txt"]);
  assert.equal(fs.readFileSync(path.join(sandbox, "a.txt"), "utf8"), "a");
  assert.equal(fs.existsSync(path.join(sandbox, "b.txt")), false);
});

test("reconciles missing PIDs and runs verification with a tail", () => {
  const cwd = makeTempDir();
  const env = { ...process.env, PI_CONNECTOR_STATE_DIR: makeTempDir() };
  const job = createJobRecord({ id: "job-dead", kind: "research", cwd, model: "m", endpoint: "local" });
  writeJob(cwd, { ...job, status: "running", pid: 99999999 }, env);
  assert.equal(reconcileJobs(cwd, { env })[0].status, "interrupted");
  const verify = runVerify("printf 'one\\ntwo\\n'", cwd);
  assert.equal(verify.exitCode, 0);
  assert.match(verify.tail, /two/);
  assert.match(resolveJobsDir(cwd, env), /jobs/);
});
