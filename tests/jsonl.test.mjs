import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createIncrementalJsonlParser, parserSummary } from "../lib/jsonl.mjs";

test("parses recorded events, partial lines, usage, final text, and tools", () => {
  const parser = createIncrementalJsonlParser();
  const input = fs.readFileSync("tests/fixtures/events-basic.jsonl");
  for (const byte of input) parser.push(Buffer.from([byte]));
  const summary = parserSummary(parser.end());
  assert.equal(summary.sessionId, "fixture-session");
  assert.equal(summary.finalText, "final answer");
  assert.deepEqual(summary.usage, { input: 4, output: 6, total: 10 });
  assert.equal(summary.toolEvents.length, 1);
});

test("preserves provider and retry errors and tolerates malformed lines", () => {
  const parser = createIncrementalJsonlParser();
  parser.push(Buffer.from(fs.readFileSync("tests/fixtures/events-errors.jsonl")));
  parser.push(Buffer.from("not json\n{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":\"partial UTF-8 ✅\"}}"));
  const summary = parserSummary(parser.end());
  assert.equal(summary.finalText, "partial UTF-8 ✅");
  assert.deepEqual(summary.providerErrors, ["provider broke", "retry exhausted"]);
  assert.equal(summary.malformedLines.length, 1);
});
