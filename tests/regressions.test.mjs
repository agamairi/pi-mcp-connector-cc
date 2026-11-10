import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJsonlState, acceptJsonEvent, parserSummary } from "../lib/jsonl.mjs";
import { runGit, createGitSandbox, diffStat, diffText } from "../lib/git.mjs";

test("object-shaped provider errors are reported as readable text, not [object Object]", () => {
  const state = createJsonlState();
  acceptJsonEvent(state, { type: "message_update", assistantMessageEvent: { type: "error", error: { message: "context length exceeded" } } });
  acceptJsonEvent(state, { type: "auto_retry_end", finalError: { code: 500, detail: "upstream" } });
  const summary = parserSummary(state);
  assert.ok(summary.providerErrors.every((e) => typeof e === "string" && !e.includes("[object Object]")));
  assert.ok(summary.providerErrors.some((e) => e.includes("context length exceeded")));
});

test("diffs include new untracked files inside a sandbox", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pic-repo-"));
  runGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  runGit(repo, ["add", "a.txt"]);
  runGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  const sandbox = path.join(os.tmpdir(), `pic-sb-${Date.now()}`);
  createGitSandbox(repo, sandbox, `pi/test-${Date.now()}`, "HEAD");
  fs.writeFileSync(path.join(sandbox, "docs-new.html"), "<!doctype html>\n");
  assert.match(diffStat(sandbox, "HEAD"), /docs-new\.html/);
  assert.match(diffText(sandbox, "HEAD"), /\+<!doctype html>/);
});

test("a recovered tool error is reported but does not count as a provider failure", () => {
  const state = createJsonlState();
  acceptJsonEvent(state, { type: "tool_execution_end", toolName: "bash", isError: true, result: "Tool bash not found" });
  const summary = parserSummary(state);
  assert.deepEqual(summary.providerErrors, []);
  assert.equal(summary.toolErrors.length, 1);
});
