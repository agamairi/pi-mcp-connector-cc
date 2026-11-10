import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildPiArgs } from "../lib/pi.mjs";
import { isProcessAlive, terminateProcessTree } from "../lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

test("builds verified pi flags and read-only tool allowlist", () => {
  const readOnly = buildPiArgs({ providerName: "pi-connector-local", model: "bonsai-2:9b", readOnly: true, thinking: "low" });
  assert.deepEqual(readOnly.slice(0, 5), ["-p", "--mode", "json", "--no-session", "--no-extensions"]);
  assert.ok(readOnly.includes("pi-connector-local/bonsai-2:9b"));
  assert.ok(readOnly.includes("--no-mcp"));
  assert.deepEqual(readOnly.slice(readOnly.indexOf("--tools"), readOnly.indexOf("--tools") + 2), ["--tools", "read,grep,find,ls"]);
  assert.ok(readOnly.includes("--thinking"));
  assert.ok(readOnly.includes("--no-approve"));
  const write = buildPiArgs({ providerName: "pi-connector-local", model: "bonsai-2:9b" });
  assert.ok(write.includes("read,edit,write,grep,find,ls"));
});

test("fake pi records argv and stdin", async () => {
  const cwd = makeTempDir();
  const argsFile = path.join(cwd, "args.json");
  const stdinFile = path.join(cwd, "stdin.txt");
  const child = (await import("node:child_process")).spawn(process.execPath, [path.resolve("tests/fixtures/fake-pi.mjs"), "-p", "--mode", "json"], { cwd, env: { ...process.env, FAKE_PI_ARGS_FILE: argsFile, FAKE_PI_STDIN_FILE: stdinFile }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("exact prompt");
  const code = await new Promise((resolve) => child.once("close", (value) => resolve(value)));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["-p", "--mode", "json"]);
  assert.equal(fs.readFileSync(stdinFile, "utf8"), "exact prompt");
});

test("terminates fake pi and its child process tree", async () => {
  const cwd = makeTempDir();
  const childFile = path.join(cwd, "child.pid");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.resolve("tests/fixtures/fake-pi.mjs")], { cwd, env: { ...process.env, FAKE_PI_SCENARIO: "hang", FAKE_PI_CHILD_FILE: childFile }, detached: true, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end();
  const closed = new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await terminateProcessTree(child.pid, { gracePeriodMs: 100, pollIntervalMs: 10 });
  await closed;
  assert.equal(result.delivered, true);
  assert.equal(isProcessAlive(child.pid), false);
  if (fs.existsSync(childFile)) assert.equal(isProcessAlive(Number(fs.readFileSync(childFile, "utf8"))), false);
});
