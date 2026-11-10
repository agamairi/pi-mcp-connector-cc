# Orchestration guidance

This connector is an orchestrator around a small local model served by Ollama through the pi harness. The selected model, endpoint, and effective context setting appear in every result header. A context warning appears when Ollama reports `num_ctx` below 8192; the connector never changes Ollama state silently.

Narrow, well-scoped edits and read-only questions are the reliable workload. Broad refactors, multi-file design work, vague prompts, and tasks without a verify command will fail or come back `needs_review`. Keep a write task to one clear goal and one to five declared files.

The model does not reliably verify its own work. The connector does. Treat the model's `## Result` block as a claim only. Trust the connector's `status`, `changed_files`, `scope`, and `verify` lines.

## Routine protocol

1. Scope the task. For writes, provide `files`, one-sentence `success_criteria`, and a concrete `verify_command`. Use `allow_bash` only when needed.
2. Launch with `pi_execute` or `pi_research`.
3. Call `pi_wait`, or poll `pi_result` until the job is no longer queued or running.
4. Read the result header. For `completed`, skim the diff stat and move on. For `needs_review`, `incomplete`, or `failed`, read the diff and decide what to do next.

Write jobs run in a disposable sandbox. Git repositories receive a kept worktree from the caller's `HEAD` or requested base and a `pi/<job-id>` branch. Non-git directories receive only the declared files. Nothing merges automatically and the user's working tree is not the write target.

The result classification is artifact-based:

- `failed`: pi exited non-zero, stalled, timed out, or reported an unrecovered provider error.
- `incomplete`: there is no diff, verification failed, or the tool-call budget was exceeded.
- `needs_review`: verification passed but the scope was violated, `allow_unscoped` was used, or the evidence is otherwise not safe to accept automatically.
- `completed`: pi exited successfully, the diff is non-empty, changed files are within scope, and verification exited 0.

Research is `completed` only when pi exits successfully with non-empty final text and no provider error. Research has `verify: n/a`.

The model name, endpoint, context, sandbox path, and branch are deliberately repeated in the header so a caller can make a quick routing decision without reading the entire transcript. Use `pi_result` with `include_diff: true` only when a result needs inspection.
