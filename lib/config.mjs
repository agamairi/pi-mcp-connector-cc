import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = Object.freeze({
  piBinary: "pi",
  defaultEndpoint: "local",
  defaultModel: "bonsai-2:9b",
  endpoints: Object.freeze({
    local: Object.freeze({ baseUrl: "http://localhost:11434/v1" }),
  }),
  timeouts: Object.freeze({
    inactivityMs: 15 * 60 * 1000,
    printMs: 20 * 60 * 1000,
  }),
  maxToolCalls: 20,
  maxPromptChars: 6000,
  trustProject: false,
});

export function parseDuration(value, name = "duration") {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const text = String(value ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text);
  if (!match) throw new Error(`Invalid ${name} "${value}". Use 500ms, 90s, 15m, or 1h.`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${name} "${value}".`);
  return result;
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export function defaultConfigPath(env = process.env) {
  return env.PI_CONNECTOR_CONFIG || homePath(".config", "pi-connector", "config.json");
}

export function agentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || homePath(".pi", "agent");
}

export function modelsJsonPath(env = process.env) {
  return path.join(agentDir(env), "models.json");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateEndpoints(endpoints) {
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    throw new Error("Config endpoints must be an object.");
  }
  const result = {};
  for (const [name, value] of Object.entries(endpoints)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`Invalid endpoint name "${name}".`);
    }
    if (typeof value === "string") result[name] = { baseUrl: value };
    else if (value && typeof value === "object" && typeof value.baseUrl === "string") {
      result[name] = { ...value };
    } else throw new Error(`Endpoint "${name}" must contain a baseUrl.`);
  }
  return result;
}

export function normalizeConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Config must be a JSON object.");
  const merged = {
    ...clone(DEFAULTS),
    ...raw,
    endpoints: validateEndpoints({ ...DEFAULTS.endpoints, ...(raw.endpoints ?? {}) }),
    timeouts: { ...DEFAULTS.timeouts, ...(raw.timeouts ?? {}) },
  };
  merged.timeouts.inactivityMs = parseDuration(merged.timeouts.inactivityMs, "inactivity timeout");
  merged.timeouts.printMs = parseDuration(merged.timeouts.printMs, "print timeout");
  if (!Number.isInteger(merged.maxToolCalls) || merged.maxToolCalls < 1) {
    throw new Error("maxToolCalls must be a positive integer.");
  }
  if (!Number.isInteger(merged.maxPromptChars) || merged.maxPromptChars < 1) {
    throw new Error("maxPromptChars must be a positive integer.");
  }
  if (typeof merged.piBinary !== "string" || !merged.piBinary.trim()) throw new Error("piBinary must be a non-empty string.");
  if (typeof merged.defaultEndpoint !== "string" || !merged.defaultEndpoint.trim()) throw new Error("defaultEndpoint must be a non-empty string.");
  if (typeof merged.defaultModel !== "string" || !merged.defaultModel.trim()) throw new Error("defaultModel must be a non-empty string.");
  if (!merged.endpoints[merged.defaultEndpoint]) throw new Error(`Default endpoint "${merged.defaultEndpoint}" is not configured.`);
  merged.trustProject = Boolean(merged.trustProject);
  return merged;
}

export function applyEnvironment(config, env = process.env) {
  const next = clone(config);
  if (env.PI_BIN) next.piBinary = env.PI_BIN;
  if (env.PI_CONNECTOR_DEFAULT_MODEL) next.defaultModel = env.PI_CONNECTOR_DEFAULT_MODEL;
  if (env.PI_CONNECTOR_DEFAULT_ENDPOINT) next.defaultEndpoint = env.PI_CONNECTOR_DEFAULT_ENDPOINT;
  if (env.PI_CONNECTOR_INACTIVITY_TIMEOUT) next.timeouts.inactivityMs = env.PI_CONNECTOR_INACTIVITY_TIMEOUT;
  if (env.PI_CONNECTOR_PRINT_TIMEOUT) next.timeouts.printMs = env.PI_CONNECTOR_PRINT_TIMEOUT;
  if (env.PI_CONNECTOR_OLLAMA_URL) {
    next.endpoints = { ...next.endpoints, local: { baseUrl: env.PI_CONNECTOR_OLLAMA_URL } };
  }
  return normalizeConfig(next);
}

export function loadConfig({ env = process.env, file = defaultConfigPath(env) } = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Unable to read config ${file}: ${error.message}`);
  }
  return applyEnvironment(normalizeConfig(raw), env);
}

export function writeConfig(config, { file, env = process.env } = {}) {
  const normalized = normalizeConfig(config);
  const target = file || defaultConfigPath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

export function updateConfig(patch, options = {}) {
  const current = loadConfig(options);
  const next = { ...current, ...patch, endpoints: { ...current.endpoints, ...(patch.endpoints ?? {}) } };
  return writeConfig(next, options);
}
