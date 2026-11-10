#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { agentDir, loadConfig, modelsJsonPath, updateConfig } from "./lib/config.mjs";
import { configuredEndpoints, resolveEndpoint } from "./lib/endpoints.mjs";
import { createSandbox, changedFiles, diffStat, diffText, gitRoot, listSandboxFiles, runVerify, validateDeclaredFiles } from "./lib/git.mjs";
import { cancelJob, createJobRecord, generateJobId, readJob, reconcileJobs, resolveJob, resolveSandboxRoot, writeJob } from "./lib/jobs.mjs";
import { createIncrementalJsonlParser, parserSummary } from "./lib/jsonl.mjs";
import { mergeManagedProviders } from "./lib/models-json.mjs";
import { getEffectiveContext, inspectEndpoint, listOllamaModels, providerForModel, resolveOllamaModel } from "./lib/ollama.mjs";
import { latestPiVersion, piVersion, spawnPi } from "./lib/pi.mjs";
import { getProcessIdentity, terminateProcessTree } from "./lib/process.mjs";
import { ORCHESTRATION_GUIDANCE, renderJob, renderSetup } from "./lib/render.mjs";
import { renderExecutePrompt, renderResearchPrompt } from "./lib/prompt.mjs";

export const INSTRUCTIONS = `# pi-connector MCP\n\nThis connector delegates work to a small local model served by Ollama through the pi harness. The model name, endpoint, and context setting are in every result header.\n\n${ORCHESTRATION_GUIDANCE}\n\nTools: pi_setup, pi_models, pi_execute, pi_research, pi_result, pi_wait, pi_list, pi_cancel, and pi_configure. Execute and research jobs run in the background; always call pi_wait or poll pi_result after launch. Write tasks run in disposable sandboxes and never modify the caller's working tree. Read the status, changed_files, and verify lines before accepting a result.`;

const WAIT_MAX_SECONDS = 300;
const activeJobs = new Map();

function textResult(text) { return { content: [{ type: "text", text: String(text) }] }; }
function jsonResult(value, isError = false) { return { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function errorResult(error) { return jsonResult({ error: error instanceof Error ? error.message : String(error) }, true); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function resolveCwd(value, base = process.cwd()) {
  const requested = value ? path.resolve(base, value) : path.resolve(base);
  return gitRoot(requested) || requested;
}

function effectiveConfig(env) { return loadConfig({ env }); }

function createConnector({ env = process.env, cwd = process.cwd() } = {}) {
  function config() { return effectiveConfig(env); }
  function jobsFor(root) { return new Set([...activeJobs.keys()].filter((id) => activeJobs.get(id)?.cwd === root)); }

  async function prepareTarget(args, cfg) {
    const initial = resolveEndpoint({ config: cfg, endpoint: args.endpoint, host: args.host, model: args.model });
    const resolved = await resolveOllamaModel(initial);
    const context = resolved.context;
    const contextWarning = context.numCtx != null && context.numCtx < 8192
      ? `num_ctx ${context.numCtx} is below 8192`
      : context.warning ?? null;
    const provider = providerForModel(resolved, { ...resolved.modelRecord, contextWindow: context.numCtx ?? undefined });
    mergeManagedProviders(modelsJsonPath(env), { [resolved.providerName]: provider });
    return { ...resolved, contextWarning, contextSetting: context.numCtx ?? "unknown" };
  }

  function checkPromptLength(value, cfg) {
    if (String(value ?? "").length > cfg.maxPromptChars) throw new Error(`Task text exceeds max_prompt_chars (${cfg.maxPromptChars}). Split the task into smaller tasks.`);
  }

  function baseJobArgs(args, kind, write) {
    const root = resolveCwd(args.cwd, cwd);
    const cfg = config();
    const modelTarget = resolveEndpoint({ config: cfg, endpoint: args.endpoint, host: args.host, model: args.model });
    return { root, cfg, modelTarget, kind, write };
  }

  async function runJob(job, args, cfg, modelTarget, prompt) {
    const active = activeJobs.get(job.id);
    const started = Date.now();
    let executionCwd = job.cwd;
    let sandbox = null;
    let initialFiles = [];
    let abortReason = null;
    let termination = null;
    const parser = createIncrementalJsonlParser();
    const stderr = [];
    const progress = (patch) => {
      const current = readJob(job.cwd, job.id, env) ?? job;
      if (current.status === "canceled") return;
      writeJob(job.cwd, { ...current, ...patch, updatedAt: new Date().toISOString() }, env);
    };
    const requestAbort = (reason) => {
      if (abortReason) return;
      abortReason = reason;
      if (active?.child?.pid) {
        termination = terminateProcessTree(active.child.pid, { identity: job.pidIdentity }).catch(() => null);
      }
    };

    try {
      const target = await prepareTarget(args, cfg);
      const afterPrepare = readJob(job.cwd, job.id, env) ?? job;
      if (active?.cancelRequested || afterPrepare.status === "canceled") return afterPrepare;
      progress({ status: "running", phase: "starting", startedAt: new Date(started).toISOString(), model: target.model, endpoint: target.endpoint, context: target.contextSetting, contextWarning: target.contextWarning });
      const currentJob = readJob(job.cwd, job.id, env) ?? job;
      if (job.write) {
        const sandboxPath = path.join(resolveSandboxRoot(job.cwd, env), job.id);
        sandbox = createSandbox(job.cwd, sandboxPath, job.id, job.files, args.base ?? null);
        executionCwd = sandbox.sandbox;
        initialFiles = listSandboxFiles(executionCwd);
        progress({ sandboxPath: executionCwd, branch: sandbox.branch, base: sandbox.base, phase: "running" });
      }
      const childResult = spawnPi({
        piBinary: cfg.piBinary,
        cwd: executionCwd,
        env: { ...env, PI_CODING_AGENT_DIR: agentDir(env) },
        providerName: target.providerName,
        model: target.model,
        readOnly: !job.write,
        thinking: args.thinking ?? null,
        trustProject: cfg.trustProject,
      });
      active.child = childResult.child;
      const pidIdentity = getProcessIdentity(childResult.child.pid);
      const fresh = readJob(job.cwd, job.id, env) ?? currentJob;
      writeJob(job.cwd, { ...fresh, pid: childResult.child.pid, pidIdentity, phase: "running", lastEventAt: new Date().toISOString() }, env);
      let lastEventAt = Date.now();
      let toolCalls = 0;
      const noteOutput = () => { lastEventAt = Date.now(); };
      childResult.child.stdout.on("data", (chunk) => {
        noteOutput();
        const before = parser.state.toolEvents.length;
        parser.push(chunk);
        const after = parser.state.toolEvents.length;
        if (after > before) {
          toolCalls += after - before;
          progress({ toolCalls, lastEventAt: new Date().toISOString() });
          if (toolCalls > job.maxToolCalls) requestAbort("budget");
        } else progress({ lastEventAt: new Date().toISOString() });
      });
      childResult.child.stderr.on("data", (chunk) => { noteOutput(); stderr.push(String(chunk)); });
      const inactivityTimer = setInterval(() => {
        if (Date.now() - lastEventAt > cfg.timeouts.inactivityMs) requestAbort("stalled");
      }, Math.max(25, Math.min(1000, cfg.timeouts.inactivityMs || 25)));
      const printTimer = setTimeout(() => requestAbort("timed_out"), cfg.timeouts.printMs);
      const close = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
        childResult.child.once("error", (error) => finish({ code: null, signal: null, error }));
        childResult.child.once("close", (code, signal) => finish({ code, signal, error: null }));
        try {
          childResult.child.stdin.write(prompt);
          childResult.child.stdin.end();
        } catch (error) { finish({ code: null, signal: null, error }); }
      });
      clearInterval(inactivityTimer);
      clearTimeout(printTimer);
      if (termination) await termination;
      parser.end();
      const summary = parserSummary(parser.state);
      const current = readJob(job.cwd, job.id, env) ?? job;
      const canceled = current.status === "canceled" || active.cancelRequested;
      const exitError = close.error?.message ?? (close.code !== 0 ? `pi exited with code ${close.code ?? "unknown"}${close.signal ? ` (${close.signal})` : ""}` : null);
      let failureError = summary.providerErrors[0] ?? null;
      if (!failureError && abortReason && abortReason !== "budget") failureError = `Job ${abortReason}.`;
      if (!failureError && abortReason !== "budget") failureError = exitError ?? (!summary.agentEnd ? "pi ended without an agent_end event." : null);
      let changed = [];
      let stat = "";
      if (job.write) {
        if (sandbox.git) {
          changed = changedFiles(executionCwd, sandbox.base || "HEAD");
          stat = diffStat(executionCwd, sandbox.base || "HEAD");
        } else {
          const afterFiles = listSandboxFiles(executionCwd);
          changed = [...new Set([...initialFiles, ...afterFiles])].filter((file) => fileContent(executionCwd, file) !== fileContent(job.cwd, file)).sort();
        }
      }
      const scopeClean = !job.write || changed.every((file) => job.files.includes(file));
      const verify = job.write && job.verifyCommand && !failureError && !abortReason && !canceled ? runVerify(job.verifyCommand, executionCwd, cfg.timeouts.printMs) : null;
      let status;
      if (canceled) status = "canceled";
      else if (abortReason && abortReason !== "budget") status = "failed";
      else if (failureError) status = "failed";
      else if (!job.write) status = summary.finalText.trim() ? "completed" : "incomplete";
      else if (abortReason === "budget" || changed.length === 0) status = "incomplete";
      else if (verify && verify.exitCode !== 0) status = "incomplete";
      else if (args.allow_unscoped || scopeClean === false) status = "needs_review";
      else if (!verify) status = "incomplete";
      else status = "completed";
      const final = {
        ...(readJob(job.cwd, job.id, env) ?? job), status, phase: status, completedAt: new Date().toISOString(), pid: null,
        sessionId: summary.sessionId, finalText: summary.finalText, usage: summary.usage, modelClaim: summary.modelClaim,
        toolCalls, durationMs: Date.now() - started, changedFiles: changed, scope: scopeClean ? (args.allow_unscoped ? "unscoped override" : "clean") : "violation",
        diffStat: stat, verify, error: canceled ? "Canceled by caller." : failureError ?? (abortReason === "budget" ? "Tool-call budget exceeded." : null), failureKind: abortReason, stderr: stderr.join("").slice(-4000),
      };
      writeJob(job.cwd, final, env);
      return final;
    } catch (error) {
      const current = readJob(job.cwd, job.id, env) ?? job;
      const final = { ...current, status: current.status === "canceled" ? "canceled" : "failed", phase: current.status === "canceled" ? "canceled" : "failed", completedAt: new Date().toISOString(), durationMs: Date.now() - started, pid: null, error: error.message };
      writeJob(job.cwd, final, env);
      return final;
    } finally {
      if (activeJobs.get(job.id)) activeJobs.get(job.id).child = null;
    }
  }

  function launch(args, { write, kind, prompt, target, files = [], successCriteria = null, verifyCommand = null, allowUnscoped = false }) {
    const id = generateJobId(write ? "execute" : "research");
    const job = createJobRecord({ id, kind, cwd: target.root, model: target.modelTarget.model, endpoint: target.modelTarget.endpoint, write, files, successCriteria, verifyCommand, maxToolCalls: target.cfg.maxToolCalls });
    job.allowUnscoped = allowUnscoped;
    writeJob(target.root, job, env);
    const active = { cwd: target.root, child: null, cancelRequested: false, promise: null };
    activeJobs.set(id, active);
    active.promise = runJob(job, { ...args, allow_unscoped: allowUnscoped }, target.cfg, target.modelTarget, prompt).finally(() => activeJobs.delete(id));
    return job;
  }

  async function handle(name, args = {}) {
    try {
      const cfg = config();
      if (name === "pi_setup") {
        const pi = piVersion(cfg.piBinary, { ...env, PI_CODING_AGENT_DIR: agentDir(env) });
        const latest = latestPiVersion();
        const endpoints = [];
        for (const endpoint of configuredEndpoints(cfg)) {
          const inspected = await inspectEndpoint(endpoint.baseUrl);
          let contextWarning = null;
          if (inspected.reachable && inspected.models.some((model) => model.id === cfg.defaultModel)) {
            const context = await getEffectiveContext(endpoint.baseUrl, cfg.defaultModel);
            contextWarning = context.numCtx != null && context.numCtx < 8192 ? `num_ctx ${context.numCtx} is below 8192` : context.warning ?? null;
          }
          endpoints.push({ endpoint: endpoint.endpoint, ...inspected, contextWarning });
        }
        return textResult(renderSetup({ pi, latest, config: cfg, endpoints }));
      }
      if (name === "pi_models") {
        const roots = args.host ? [resolveEndpoint({ config: cfg, host: args.host, model: args.model })] : args.endpoint ? [resolveEndpoint({ config: cfg, endpoint: args.endpoint, model: args.model })] : configuredEndpoints(cfg);
        const result = [];
        for (const root of roots) result.push({ endpoint: root.endpoint, baseUrl: root.baseUrl, models: await listOllamaModels(root.baseUrl) });
        return jsonResult(result);
      }
      if (name === "pi_configure") {
        if (!args.default_model && !args.default_endpoint && !(args.endpoint_name && args.base_url)) throw new Error("pi_configure requires default_model, default_endpoint, or endpoint_name plus base_url.");
        const patch = {};
        if (args.default_model) patch.defaultModel = args.default_model;
        if (args.default_endpoint) patch.defaultEndpoint = args.default_endpoint;
        if (args.endpoint_name && args.base_url) patch.endpoints = { [args.endpoint_name]: { baseUrl: args.base_url } };
        updateConfig(patch, { env, file: env.PI_CONNECTOR_CONFIG });
        return textResult(`Configuration saved to ${env.PI_CONNECTOR_CONFIG ?? "the default pi-connector config path"}.`);
      }
      if (name === "pi_research" || name === "pi_execute") {
        const text = args.task ?? args.question;
        if (typeof text !== "string" || !text.trim()) throw new Error(`${name} requires task text.`);
        checkPromptLength(text, cfg);
        const base = baseJobArgs(args, name === "pi_execute" ? "execute" : "research", name === "pi_execute");
        let files = [];
        let allowUnscoped = Boolean(args.allow_unscoped);
        if (name === "pi_execute") {
          if (args.files == null && !allowUnscoped) throw new Error("pi_execute requires files (1 to 5 repo-relative paths).");
          if (args.files != null) files = validateDeclaredFiles(args.files);
          if (!args.success_criteria && !allowUnscoped) throw new Error("pi_execute requires success_criteria.");
          if (!args.verify_command && !allowUnscoped) throw new Error("pi_execute requires verify_command.");
        }
        const prompt = name === "pi_execute"
          ? renderExecutePrompt({ task: text, files, successCriteria: args.success_criteria ?? "not supplied; needs review", verifyCommand: args.verify_command ?? "not supplied; needs review", allowBash: Boolean(args.allow_bash) })
          : renderResearchPrompt({ question: text });
        const job = launch({ ...args, thinking: args.thinking }, { write: name === "pi_execute", kind: name === "pi_execute" ? "execute" : "research", prompt, target: base, files, successCriteria: args.success_criteria ?? null, verifyCommand: args.verify_command ?? null, allowUnscoped });
        return jsonResult({ job_id: job.id });
      }
      const root = resolveCwd(args.cwd, cwd);
      if (name === "pi_result") {
        const job = resolveJob(root, args.job_id, { activeIds: jobsFor(root), env });
        if (!job) throw new Error("No jobs are tracked for this workspace.");
        const active = activeJobs.get(job.id);
        let diff = "";
        if (args.include_diff && job.sandboxPath && job.base) diff = diffText(job.sandboxPath, job.base);
        return textResult(renderJob(job, { includeDiff: Boolean(args.include_diff), diff }));
      }
      if (name === "pi_wait") {
        const timeout = Math.min(WAIT_MAX_SECONDS, Math.max(0, Number(args.timeout_seconds ?? 240))) * 1000;
        const deadline = Date.now() + timeout;
        let job = resolveJob(root, args.job_id, { activeIds: jobsFor(root), env });
        while (job && ["queued", "running"].includes(job.status) && Date.now() < deadline) {
          await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
          job = resolveJob(root, args.job_id, { activeIds: jobsFor(root), env });
        }
        if (!job) throw new Error("No jobs are tracked for this workspace.");
        return textResult(renderJob(job));
      }
      if (name === "pi_list") {
        return jsonResult(reconcileJobs(root, { activeIds: jobsFor(root), env }).map((job) => ({ id: job.id, kind: job.kind, status: job.status, model: job.model, endpoint: job.endpoint, updatedAt: job.updatedAt })));
      }
      if (name === "pi_cancel") {
        const job = resolveJob(root, args.job_id, { activeIds: jobsFor(root), env });
        const active = activeJobs.get(job.id);
        if (active) active.cancelRequested = true;
        const canceled = await cancelJob(root, job, { active, env });
        return textResult(renderJob(canceled));
      }
      throw new Error(`Unknown tool ${name}.`);
    } catch (error) {
      return errorResult(error);
    }
  }

  return { handle, activeJobs, config, root: cwd };
}

function fileContent(root, relative) {
  try { return fs.readFileSync(path.join(root, relative), "utf8"); } catch { return null; }
}

export { createConnector };

const TOOL_DEFINITIONS = [
  { name: "pi_setup", description: "Report pi, Ollama, configured endpoints, models, and context settings without changing state.", inputSchema: { type: "object", properties: {} } },
  { name: "pi_models", description: "List Ollama models for one endpoint, host, or all configured endpoints.", inputSchema: { type: "object", properties: { endpoint: { type: "string" }, host: { type: "string" }, model: { type: "string" } } } },
  { name: "pi_execute", description: "Launch a scoped write task in a disposable git worktree or declared-file copy sandbox. Returns a job_id; wait for and inspect the result.", inputSchema: { type: "object", properties: { task: { type: "string" }, files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }, success_criteria: { type: "string" }, verify_command: { type: "string" }, model: { type: "string" }, endpoint: { type: "string" }, host: { type: "string" }, thinking: { type: "string", enum: ["off", "low", "medium", "high"] }, cwd: { type: "string" }, base: { type: "string" }, allow_bash: { type: "boolean" }, allow_unscoped: { type: "boolean" } }, required: ["task", "files", "success_criteria", "verify_command"] } },
  { name: "pi_research", description: "Launch a strictly read-only research task. Returns a job_id; wait for and inspect the result.", inputSchema: { type: "object", properties: { task: { type: "string" }, question: { type: "string" }, model: { type: "string" }, endpoint: { type: "string" }, host: { type: "string" }, thinking: { type: "string", enum: ["off", "low", "medium", "high"] }, cwd: { type: "string" } }, required: ["task"] } },
  { name: "pi_result", description: "Get a non-blocking status or result. Trust status, changed_files, and verify rather than model prose.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, cwd: { type: "string" }, include_diff: { type: "boolean" } } } },
  { name: "pi_wait", description: "Wait up to 300 seconds for a job, then return its result header.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, cwd: { type: "string" }, timeout_seconds: { type: "number" } } } },
  { name: "pi_list", description: "List tracked jobs for a workspace.", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "pi_cancel", description: "Cancel an active job and terminate its process tree.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, cwd: { type: "string" } } } },
  { name: "pi_configure", description: "Persist an explicit default model, default endpoint, or named endpoint URL.", inputSchema: { type: "object", properties: { default_model: { type: "string" }, default_endpoint: { type: "string" }, endpoint_name: { type: "string" }, base_url: { type: "string" } } } },
];

export async function startServer() {
  const connector = createConnector();
  const server = new Server({ name: "pi-connector", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => connector.handle(request.params.name, request.params.arguments ?? {}));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer().catch((error) => { console.error(error); process.exitCode = 1; });
