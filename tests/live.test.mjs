import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createConnector } from "../server.mjs";
import { makeTempDir } from "./helpers.mjs";

test("live read-only research against local bonsai-2:9b", { timeout: 320_000, skip: process.env.PI_CONNECTOR_LIVE !== "1" ? "set PI_CONNECTOR_LIVE=1 to run the live Ollama smoke test" : false }, async (t) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch("http://localhost:11434/api/version", { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) { t.skip("local Ollama is not reachable"); return; }
  } catch {
    t.skip("local Ollama is not reachable");
    return;
  }
  const agent = makeTempDir("pi-connector-live-agent-");
  const env = { ...process.env, PI_CONNECTOR_LIVE: "1", PI_BIN: process.env.PI_BIN || "/opt/homebrew/bin/pi", PI_CODING_AGENT_DIR: agent, PI_CONNECTOR_STATE_DIR: makeTempDir("pi-connector-live-state-") };
  const connector = createConnector({ env, cwd: process.cwd() });
  const launched = await connector.handle("pi_research", { task: "In one concise paragraph, name the two specification files in this repository and explain which one overrides the other.", endpoint: "local", model: "bonsai-2:9b", cwd: process.cwd() });
  assert.notEqual(launched.isError, true);
  const jobId = JSON.parse(launched.content[0].text).job_id;
  const result = await connector.handle("pi_wait", { job_id: jobId, cwd: process.cwd(), timeout_seconds: 300 });
  assert.match(result.content[0].text, /status: completed/);
  assert.match(result.content[0].text, /answer:/);
});
