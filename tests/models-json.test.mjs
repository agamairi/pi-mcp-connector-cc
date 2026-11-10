import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { mergeManagedProviders } from "../lib/models-json.mjs";

test("merges only pi-connector providers, backs up once, and is idempotent", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "models.json");
  const backup = `${file}.pi-connector.bak`;
  const original = JSON.stringify({ providers: { openai: { api: "openai-completions", models: [{ id: "gpt" }] }, "pi-connector-old": { old: true } }, other: { keep: [1, 2] } }, null, 2) + "\n";
  fs.writeFileSync(file, original);
  const provider = { baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "bonsai-2:9b" }] };
  const first = mergeManagedProviders(file, { "pi-connector-local": provider });
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  const afterFirst = fs.readFileSync(file, "utf8");
  const second = mergeManagedProviders(file, { "pi-connector-local": provider });
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(file, "utf8"), afterFirst);
  const parsed = JSON.parse(afterFirst);
  assert.deepEqual(parsed.providers.openai, JSON.parse(original).providers.openai);
  assert.deepEqual(parsed.other, { keep: [1, 2] });
  assert.throws(() => mergeManagedProviders(file, { openai: {} }), /outside/);
});
