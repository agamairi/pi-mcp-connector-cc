import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createConnector } from "../server.mjs";
import { createOllamaStub } from "./fixtures/ollama-stub.mjs";
import { makeTempDir } from "./helpers.mjs";

const fakePi = path.resolve("tests/fixtures/fake-pi.mjs");

async function withConnector(options, testContext, callback) {
  const stub = createOllamaStub({ numCtx: options.numCtx ?? 8192 });
  let port;
  try {
    port = await stub.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      testContext.skip("sandbox does not permit local HTTP listeners");
      return;
    }
    throw error;
  }
  const dir = makeTempDir();
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "before\n");
  const env = {
    ...process.env,
    PI_BIN: fakePi,
    PI_CONNECTOR_CONFIG: path.join(dir, "config.json"),
    PI_CONNECTOR_STATE_DIR: path.join(dir, "state"),
    PI_CODING_AGENT_DIR: path.join(dir, "agent"),
    FAKE_PI_SCENARIO: options.scenario ?? "success",
    FAKE_PI_EDIT_FILE: options.editFile ?? "",
    FAKE_PI_SCOPE_VIOLATION: options.scopeViolation ? "1" : "0",
    FAKE_PI_TOOL_CALLS: options.toolCalls == null ? "0" : String(options.toolCalls),
  };
  fs.writeFileSync(env.PI_CONNECTOR_CONFIG, JSON.stringify({ endpoints: { local: { baseUrl: `http://127.0.0.1:${port}/v1` } }, defaultEndpoint: "local", defaultModel: "bonsai-2:9b", maxToolCalls: options.maxToolCalls ?? 20, timeouts: { inactivityMs: options.inactivityMs ?? "2s", printMs: options.printMs ?? "10s" } }));
  try { return await callback(createConnector({ env, cwd: repo }), { repo, env }); } finally { await stub.close(); }
}

function jobId(result) { return JSON.parse(result.content[0].text).job_id; }

test("research uses the Ollama stub, records session and context warning, and completes", async (t) => {
  await withConnector({ numCtx: 4096, editFile: "" }, t, async (connector, { repo }) => {
    const launched = await connector.handle("pi_research", { task: "What is in a.txt?", cwd: repo });
    const result = await connector.handle("pi_wait", { job_id: jobId(launched), cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: completed/);
    assert.match(result.content[0].text, /context: 4096 warning: num_ctx 4096/);
    assert.match(result.content[0].text, /fake-session-123/);
  });
});

test("execute requires scope fields and classifies clean verified changes as completed", async (t) => {
  await withConnector({ editFile: "a.txt" }, t, async (connector, { repo }) => {
    const rejected = await connector.handle("pi_execute", { task: "edit it", cwd: repo });
    assert.equal(rejected.isError, true);
    const launched = await connector.handle("pi_execute", { task: "edit it", files: ["a.txt"], success_criteria: "a.txt changes", verify_command: "test -f a.txt", cwd: repo });
    const result = await connector.handle("pi_wait", { job_id: jobId(launched), cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: completed/);
    assert.match(result.content[0].text, /changed_files: a.txt/);
    assert.match(result.content[0].text, /exit_code: 0/);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "before\n");
  });
});

test("scope violations return needs_review and verification failures return incomplete", async (t) => {
  await withConnector({ editFile: "a.txt", scopeViolation: true }, t, async (connector, { repo }) => {
    const launched = await connector.handle("pi_execute", { task: "edit it", files: ["a.txt"], success_criteria: "change", verify_command: "true", cwd: repo });
    const result = await connector.handle("pi_wait", { job_id: jobId(launched), cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: needs_review/);
    assert.match(result.content[0].text, /scope: violation/);
  });
  await withConnector({ editFile: "a.txt" }, t, async (connector, { repo }) => {
    const launched = await connector.handle("pi_execute", { task: "edit it", files: ["a.txt"], success_criteria: "change", verify_command: "false", cwd: repo });
    const result = await connector.handle("pi_wait", { job_id: jobId(launched), cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: incomplete/);
  });
});

test("budget overflow is incomplete and prompt length is rejected", async (t) => {
  await withConnector({ editFile: "a.txt", toolCalls: 3, maxToolCalls: 2 }, t, async (connector, { repo }) => {
    const launched = await connector.handle("pi_execute", { task: "edit it", files: ["a.txt"], success_criteria: "change", verify_command: "true", cwd: repo });
    const result = await connector.handle("pi_wait", { job_id: jobId(launched), cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: incomplete/);
  });
  await withConnector({}, t, async (connector, { repo }) => {
    const rejected = await connector.handle("pi_research", { task: "x".repeat(6001), cwd: repo });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /max_prompt_chars/);
  });
});
