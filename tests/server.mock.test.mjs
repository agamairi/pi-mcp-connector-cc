import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConnector } from "../server.mjs";

const fakePi = path.resolve("tests/fixtures/fake-pi.mjs");

function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

test("server classifies a mocked Ollama research and write job", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/api/tags")) return response({ models: [{ name: "bonsai-2:9b", capabilities: ["thinking", "vision"] }] });
    if (value.endsWith("/api/show")) return response({ parameters: "num_ctx 4096" });
    if (value.endsWith("/api/ps")) return response({ models: [] });
    if (value.endsWith("/api/version")) return response({ version: "0.40.16" });
    return response({ error: "missing" }, 404);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-connector-server-test-"));
  const repo = path.join(root, "repo"); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, "a.txt"), "before\n");
  const env = { ...process.env, PI_BIN: fakePi, PI_CONNECTOR_CONFIG: path.join(root, "config.json"), PI_CONNECTOR_STATE_DIR: path.join(root, "state"), PI_CODING_AGENT_DIR: path.join(root, "agent"), FAKE_PI_EDIT_FILE: "a.txt" };
  fs.writeFileSync(env.PI_CONNECTOR_CONFIG, JSON.stringify({ endpoints: { local: { baseUrl: "http://mock/v1" } }, defaultEndpoint: "local", defaultModel: "bonsai-2:9b", timeouts: { inactivityMs: "2s", printMs: "10s" } }));
  try {
    const connector = createConnector({ env, cwd: repo });
    const launched = await connector.handle("pi_execute", { task: "edit", files: ["a.txt"], success_criteria: "file changes", verify_command: "test -f a.txt", cwd: repo });
    const id = JSON.parse(launched.content[0].text).job_id;
    const result = await connector.handle("pi_wait", { job_id: id, cwd: repo, timeout_seconds: 5 });
    assert.match(result.content[0].text, /status: completed/);
    assert.match(result.content[0].text, /context: 4096 warning/);
    assert.match(result.content[0].text, /session: fake-session-123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
