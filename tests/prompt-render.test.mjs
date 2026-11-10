import assert from "node:assert/strict";
import test from "node:test";
import { renderExecutePrompt } from "../lib/prompt.mjs";
import { renderHeader } from "../lib/render.mjs";

test("renders the required prompt section order and final result block", () => {
  const prompt = renderExecutePrompt({ task: "change one file", files: ["src/a.js"], successCriteria: "test passes", verifyCommand: "npm test" });
  const sections = ["## ROLE", "## GOAL", "## FILES", "## CONSTRAINTS", "## STEPS", "## DONE WHEN", "## OUTPUT"];
  for (let index = 1; index < sections.length; index += 1) assert.ok(prompt.indexOf(sections[index - 1]) < prompt.indexOf(sections[index]));
  assert.equal(prompt.trimEnd().endsWith("notes: <one line>"), true);
  assert.equal(prompt.includes("src/a.js"), true);
});

test("result header has the contract fields in order", () => {
  const header = renderHeader({ status: "completed", model: "m", endpoint: "local", context: 4096, contextWarning: "num_ctx 4096 is below 8192", sandboxPath: "/tmp/s", branch: "pi/x" });
  assert.ok(header.indexOf("status:") < header.indexOf("model:"));
  assert.ok(header.indexOf("model:") < header.indexOf("endpoint:"));
  assert.ok(header.indexOf("endpoint:") < header.indexOf("context:"));
  assert.match(header, /warning: num_ctx 4096/);
});
