# Small-model operating contract

This contract is required. It amends `PLAN.md`. Where the two disagree, this file wins.

## Why this exists

The models behind pi are small local models, such as `bonsai-2:9b` on Ollama. Assume the following:

- Usable context is small. Ollama may default to a small `num_ctx` even when the model supports 262144. Treat about 8k tokens as the working ceiling.
- Multi-step planning is weak. Broad, vague tasks fail.
- The model may claim success without running checks. It may edit the wrong files.

So the connector, not the model, sets the scope, runs the checks, and decides whether the work is complete.

## 1. Sandbox rules

1. **Write tasks run in a disposable git worktree.** Create it from the caller's HEAD, or from `base` if given:
   `git -C <repo> worktree add <state>/sandboxes/<job-id> -b pi/<job-id> <base>`
   Never write to the user's working tree. If the target is not a git repo, copy only the declared `files` into a fresh temp dir. Do not copy the whole repo.
2. **Research tasks are read-only.** They run with `cwd` set to the repo and the tools `read,grep,find,ls`. No worktree is needed.
3. **Scope is required for write tasks.** `pi_execute` must receive all of:
   - `files`: 1 to 5 repo-relative paths the model may edit.
   - `success_criteria`: one sentence.
   - `verify_command`: a shell command the connector runs in the sandbox after pi finishes, for example `npm test -- tests/foo.test.mjs`.

   Reject the call if any of these are missing. The only override is `allow_unscoped: true`, and the result must then be marked `needs_review`.
4. **Tools per task.**
   - execute: `read,edit,write,grep,find,ls`. Add `bash` only with `allow_bash: true`.
   - research: `read,grep,find,ls`.
5. **Budgets.** Enforce all of these in the connector:
   - `max_tool_calls`, default 20. Count `tool_execution_start` events. Cancel the job when the count is exceeded and report `incomplete`.
   - Inactivity timeout and print timeout, as in `PLAN.md`.
   - `max_prompt_chars`, default 6000. Reject larger task text with a message telling the caller to split the task.
6. **Prompt template.** The connector renders the prompt. The caller fills slots only. Do not pass free-form prompts to pi. The template has these sections in this order:
   `ROLE`, `GOAL`, `FILES` (the declared list, nothing else), `CONSTRAINTS`, `STEPS` (at most 5 numbered), `DONE WHEN` (the success criteria and `verify_command`), `OUTPUT` (the format below).

   The model must end with this block, and nothing after it:

   ```
   ## Result
   status: done | blocked
   changed_files: <comma list, or none>
   notes: <one line>
   ```
7. **Context check.** `pi_setup` and every job start must read the effective `num_ctx` from Ollama (`/api/show` or `/api/ps`). If `num_ctx` is below 8192, print a warning in the result header. Do not change it silently. Offer to create an Ollama variant with `PARAMETER num_ctx 8192` only after the user approves, because `ollama create` changes the user's Ollama state.

## 2. Completion is decided by output, not chat

The connector classifies every job from artifacts. The model's own claims are shown but do not count.

Inputs:
- pi exit code and whether `agent_end` was reached with no unrecovered `auto_retry_end.finalError`.
- `git -C <sandbox> diff --stat <base>...HEAD` and the working tree status. Use the diff, not the message.
- Scope check: changed files must be a subset of the declared `files`. Any other file is a scope violation.
- Exit code and the last 40 lines of output of `verify_command`, run by the connector in the sandbox.
- Whether the tool-call budget was exceeded.
- Whether the `## Result` block is present. Record it as a claim only.

Classification, checked in this order:

| status | when |
|---|---|
| `failed` | pi exited non-zero, stalled, timed out, or hit a provider error |
| `incomplete` | no diff, or `verify_command` fails, or budget exceeded |
| `needs_review` | verify passes but there is a scope violation, or `allow_unscoped` was used, or `verify_command` is missing for a read-only research task that claims a change |
| `completed` | diff is non-empty, scope is clean, and `verify_command` exits 0 |

Research jobs are `completed` when pi exits 0 with a non-empty final answer and no provider error. Their `verify` line reads `n/a`.

Every result shows, in this order:
1. Header: `status`, model, endpoint, context setting and warning if any, sandbox path, branch.
2. `changed_files` from git, and scope result.
3. `verify`: command, exit code, and tail.
4. Budget used: tool calls, duration.
5. Model claim, labeled `model claim (unverified)`, truncated to 1500 characters.

Sandbox branches are kept. Nothing merges automatically. Add `pi_result` with `include_diff: true` to return the full diff.

## 3. The orchestrator must know what it is working with

Claude Code, or any caller of this connector, must be told the following. Put this in the MCP server `instructions` field, in `README.md`, and in `docs/ORCHESTRATION.md`.

- Work is done by a small local model served by Ollama, via the pi harness. The model name, endpoint, and context setting are in every result header.
- Expect this: narrow, well-scoped edits and read-only questions succeed. Broad refactors, multi-file design work, and tasks without a verify command will fail or come back `needs_review`.
- The model does not reliably verify its own work. The connector does. Trust the `status`, `changed_files`, and `verify` lines.
- Routine protocol: scope the task, launch, wait, read the header. For `completed`, skim the diff stat and move on. Do not re-audit the whole repo. For `needs_review`, `incomplete`, or `failed`, read the diff and decide.
- Do not treat the model's prose as evidence of completion.

## 4. Tests to add beyond PLAN.md

- Sandbox creation: worktree created from base, user's working tree untouched.
- Scope violation: edit outside `files` yields `needs_review`.
- Verify runner: exit 0 yields `completed`, non-zero yields `incomplete`.
- Budget: fake pi emitting more than `max_tool_calls` tool starts is cancelled and marked `incomplete`.
- Missing `files`, `success_criteria`, or `verify_command` on execute is rejected.
- `max_prompt_chars` rejection.
- Template: rendered prompt has sections in the required order.
- Context warning appears when `num_ctx` is below 8192 (use the Ollama stub).
- Result header contains the required fields in order.

## 5. What not to do

- Do not add the pi-side MCP adapter as a dependency. The user installed `npm:pi-mcp-adapter` on pi separately, and the connector does not use it.
- Do not run `ollama create`, `ollama pull`, or any Ollama state change.
- Do not commit or push. Do not touch the real `~/.pi/agent/models.json` outside a temp `PI_CODING_AGENT_DIR`.
