import { formatDuration } from "./jobs.mjs";

export const ORCHESTRATION_GUIDANCE = `Work is done by a small local model served by Ollama, via the pi harness. The model name, endpoint, and context setting are in every result header.

Expect narrow, well-scoped edits and read-only questions to succeed. Broad refactors, multi-file design work, and tasks without a verify command will fail or come back needs_review.

The model does not reliably verify its own work. The connector does. Trust the status, changed_files, and verify lines. Routine protocol: scope the task, launch, wait, read the header. For completed, skim the diff stat and move on. For needs_review, incomplete, or failed, read the diff and decide. Do not treat the model's prose as evidence of completion.`;

function line(value) { return String(value ?? "n/a"); }

export function renderHeader(job) {
  const context = job.context ?? "unknown";
  const warning = job.contextWarning ? ` warning: ${job.contextWarning}` : "";
  return [
    `status: ${line(job.status)}`,
    `model: ${line(job.model)}`,
    `endpoint: ${line(job.endpoint)}`,
    `context: ${context}${warning}`,
    `sandbox: ${line(job.sandboxPath)}`,
    `branch: ${line(job.branch)}`,
    `session: ${line(job.sessionId)}`,
  ].join("\n");
}

export function renderJob(job, { includeDiff = false, diff = "" } = {}) {
  const verify = job.verify ? `command: ${job.verify.command}\nexit_code: ${line(job.verify.exitCode)}\ntail:\n${job.verify.tail || "(no output)"}` : "n/a";
  const claim = job.modelClaim ? job.modelClaim : "(no ## Result claim)";
  const body = [
    renderHeader(job),
    `changed_files: ${job.changedFiles?.length ? job.changedFiles.join(", ") : "none"}`,
    `scope: ${line(job.scope)}`,
    `verify: ${verify}`,
    `budget: tool_calls=${job.toolCalls ?? 0}/${job.maxToolCalls ?? "n/a"}, duration=${formatDuration(job.durationMs ?? 0)}`,
    `model claim (unverified):\n${claim}`,
  ];
  if (job.error) body.push(`error: ${job.error}`);
  if (job.finalText && job.kind === "research") body.push(`answer:\n${job.finalText}`);
  if (includeDiff) body.push(`diff:\n${diff || "(no diff)"}`);
  return body.join("\n\n");
}

export function renderSetup(report) {
  const currentVersion = String(report.pi.version ?? "").match(/\d+(?:\.\d+)+/)?.[0] ?? null;
  const latestVersion = String(report.latest.version ?? "").match(/\d+(?:\.\d+)+/)?.[0] ?? null;
  const behind = currentVersion && latestVersion ? currentVersion !== latestVersion : null;
  const lines = [
    `pi: ${report.pi.available ? `found (${report.pi.version ?? "version unavailable"})${behind == null ? "" : ` (behind latest: ${behind ? "yes" : "no"})`}` : `missing (${report.pi.error})`}`,
    `latest npm version: ${report.latest.version ?? report.latest.error ?? "unknown"}`,
    `node: ${process.version}`,
    `default: ${report.config.defaultEndpoint}/${report.config.defaultModel}`,
  ];
  for (const item of report.endpoints) {
    lines.push(`${item.endpoint}: ${item.reachable ? `reachable ${item.version ?? ""}` : `unreachable (${item.error})`}`);
    if (item.models?.length) lines.push(`  models: ${item.models.map((model) => model.id).join(", ")}`);
    if (item.contextWarning) lines.push(`  context: ${item.contextWarning}`);
  }
  return lines.join("\n");
}
