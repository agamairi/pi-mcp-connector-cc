import assert from "node:assert/strict";
import test from "node:test";
import { createConnector } from "../server.mjs";

test("rejects unscoped execute requirements and oversized prompt text before starting a job", async () => {
  const connector = createConnector({ cwd: process.cwd(), env: { ...process.env, PI_CONNECTOR_CONFIG: "/private/tmp/pi-connector-validation-config-that-does-not-exist.json" } });
  const missingFiles = await connector.handle("pi_execute", { task: "edit" });
  assert.equal(missingFiles.isError, true);
  assert.match(missingFiles.content[0].text, /files/);
  const missingCriteria = await connector.handle("pi_execute", { task: "edit", files: ["a.txt"] });
  assert.equal(missingCriteria.isError, true);
  assert.match(missingCriteria.content[0].text, /success_criteria/);
  const oversized = await connector.handle("pi_research", { task: "x".repeat(6001) });
  assert.equal(oversized.isError, true);
  assert.match(oversized.content[0].text, /max_prompt_chars/);
});
