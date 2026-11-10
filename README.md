# pi-connector-cc

`pi-connector-cc` is an MCP stdio server that lets Claude Code delegate narrow coding and research jobs to the `pi` coding agent using an Ollama model. Jobs are background jobs: launch with `pi_execute` or `pi_research`, then call `pi_wait` or poll `pi_result`.

## Setup

Requirements are Node 22.19 or newer, pi 1.5.1 (or a compatible pi binary), and an Ollama endpoint with the requested model. From this directory:

```bash
npm install
```

The default endpoint is `http://localhost:11434/v1` and the default model is `bonsai-2:9b`. Set `PI_BIN` if `pi` is not on `PATH`, or put `piBinary` in `~/.config/pi-connector/config.json`. Other useful environment overrides are `PI_CONNECTOR_CONFIG`, `PI_CONNECTOR_DEFAULT_MODEL`, `PI_CONNECTOR_DEFAULT_ENDPOINT`, `PI_CONNECTOR_OLLAMA_URL`, `PI_CONNECTOR_INACTIVITY_TIMEOUT`, and `PI_CONNECTOR_PRINT_TIMEOUT`.

Register it with Claude Code using the absolute path:

```bash
claude mcp add pi-connector -- node /absolute/path/to/pi-connector-cc/server.mjs
```

Use `pi_setup` first. It reports whether pi is found, which configured Ollama endpoints are reachable, their model lists, and the effective context setting. The connector adds only providers whose keys start with `pi-connector-` to the pi `models.json`; unrelated providers are preserved, the first write creates `models.json.pi-connector.bak`, and writes are atomic.

The connector never installs pi, pulls or creates Ollama models, changes Ollama settings, or uses the separately installed `pi-mcp-adapter` package. It passes pi's `--no-mcp` flag so a pi-side MCP configuration cannot widen the task's tool surface.

## LAN Ollama

On the remote box, Ollama must listen beyond loopback:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

On macOS, use `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` and restart the Ollama app. Ollama has no authentication; expose it only on a trusted LAN and firewall the port. Configure an endpoint such as:

```json
{
  "endpoints": {
    "office-box": { "baseUrl": "http://192.168.1.50:11434/v1" }
  }
}
```

The caller may instead pass `host: "192.168.1.50"`. A host wins over a named endpoint and creates the managed provider `pi-connector-192-168-1-50`.

## Sandbox and write-mode risk

Research jobs run in the caller's repository with only `read,grep,find,ls`. Write jobs never edit the caller's working tree: in a git repository they run in a kept disposable worktree created from `HEAD` (or the requested `base`), and in a non-git directory they receive only the declared files in a fresh sandbox. The sandbox branch is never merged automatically.

`pi_execute` requires `files` (one to five repo-relative paths), `success_criteria`, and `verify_command`. The connector renders a fixed prompt, limits pi to `read,edit,write,grep,find,ls`, enforces a tool-call budget, runs the verify command in the sandbox, checks changed files against the declared scope, and classifies completion from those artifacts. `allow_bash: true` adds pi's `bash` tool. `allow_unscoped: true` is an explicit escape hatch and always produces `needs_review` when verification otherwise passes.

Write mode is still a risk surface: a local model can make harmful changes inside its sandbox, and an approved `verify_command` can run arbitrary shell code there. Review `changed_files`, `scope`, `verify`, and `include_diff` before merging anything manually.

Never treat the model's `## Result` prose as proof of completion. Trust the connector's `status`, changed files, and verification lines. See [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) for the routine caller workflow and the small-model operating guidance.

## Configuration

The optional config file is `~/.config/pi-connector/config.json` or `PI_CONNECTOR_CONFIG`:

```json
{
  "piBinary": "pi",
  "defaultEndpoint": "local",
  "defaultModel": "bonsai-2:9b",
  "endpoints": {
    "local": { "baseUrl": "http://localhost:11434/v1" }
  },
  "timeouts": { "inactivityMs": "15m", "printMs": "20m" },
  "maxToolCalls": 20,
  "maxPromptChars": 6000,
  "trustProject": false
}
```

`trustProject` is false by default, so pi is started with `--no-approve`. Set it only when the user has explicitly opted into pi's project trust behavior.

## Tests

```bash
npm test
```

The suite uses a fake pi binary and an Ollama HTTP stub. It does not use the real `~/.pi/agent/models.json`. The live smoke test is skipped unless `PI_CONNECTOR_LIVE=1`; when enabled, it uses a temporary `PI_CODING_AGENT_DIR` and runs a read-only question against local `bonsai-2:9b`.
