#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_ARGS_FILE) fs.writeFileSync(process.env.FAKE_PI_ARGS_FILE, JSON.stringify(args, null, 2));
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (process.env.FAKE_PI_STDIN_FILE) fs.writeFileSync(process.env.FAKE_PI_STDIN_FILE, prompt);
  run();
});

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

function run() {
  const scenario = process.env.FAKE_PI_SCENARIO || "success";
  if (process.env.FAKE_PI_CHILD_FILE) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: false, stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_PI_CHILD_FILE, String(child.pid));
  }
  if (scenario === "hang" || process.env.FAKE_PI_HANG === "1") {
    if (process.env.FAKE_PI_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === "fail" || process.env.FAKE_PI_FAIL === "1") {
    emit({ type: "session", id: "fake-session-fail", version: 1, cwd: process.cwd(), timestamp: new Date().toISOString() });
    emit({ type: "message_update", assistantMessageEvent: { type: "error", error: "fixture provider failure" } });
    process.exitCode = 2;
    return;
  }
  emit({ type: "session", id: process.env.FAKE_PI_SESSION_ID || "fake-session-123", version: 1, cwd: process.cwd(), timestamp: new Date().toISOString() });
  emit({ type: "agent_start" });
  const calls = Number(process.env.FAKE_PI_TOOL_CALLS || (scenario === "budget" ? 25 : 0));
  for (let index = 0; index < calls; index += 1) emit({ type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "read", args: { path: "README.md" } });
  const editFile = process.env.FAKE_PI_EDIT_FILE;
  if (editFile) {
    const absolute = path.resolve(process.cwd(), editFile);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, process.env.FAKE_PI_EDIT_CONTENT || "fixture change\n");
  }
  if (process.env.FAKE_PI_SCOPE_VIOLATION === "1") fs.writeFileSync(path.join(process.cwd(), "outside-scope.txt"), "scope violation\n");
  emit({ type: "message_update", usage: { input: 10, output: 20, total: 30 }, assistantMessageEvent: { type: "text_delta", delta: "fixture" } });
  const answer = process.env.FAKE_PI_FINAL_TEXT || "## Result\nstatus: done\nchanged_files: none\nnotes: fixture completed";
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
  emit({ type: "agent_end", messages: [], willRetry: false });
  if (scenario === "partial") process.stdout.write("{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":\"partial\"}}");
}
