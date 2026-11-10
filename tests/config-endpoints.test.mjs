import assert from "node:assert/strict";
import test from "node:test";
import { applyEnvironment, normalizeConfig, parseDuration } from "../lib/config.mjs";
import { endpointApiRoot, hostSlug, normalizeBaseUrl, resolveEndpoint } from "../lib/endpoints.mjs";

test("parses supported durations", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.throws(() => parseDuration("tomorrow"), /Invalid duration/);
});

test("environment overrides have precedence and create local Ollama endpoint", () => {
  const config = applyEnvironment(normalizeConfig({ defaultModel: "old", timeouts: { inactivityMs: "1m" } }), {
    PI_CONNECTOR_DEFAULT_MODEL: "bonsai-2:9b",
    PI_CONNECTOR_OLLAMA_URL: "http://box.lan:11434/v1",
    PI_CONNECTOR_INACTIVITY_TIMEOUT: "90s",
    PI_BIN: "/tmp/pi",
  });
  assert.equal(config.defaultModel, "bonsai-2:9b");
  assert.equal(config.piBinary, "/tmp/pi");
  assert.equal(config.timeouts.inactivityMs, 90_000);
  assert.equal(config.endpoints.local.baseUrl, "http://box.lan:11434/v1");
});

test("normalizes hosts and rejects credentials, query strings, fragments, and schemes", () => {
  assert.equal(normalizeBaseUrl("192.168.1.50"), "http://192.168.1.50/v1");
  assert.equal(normalizeBaseUrl("192.168.1.50:11435"), "http://192.168.1.50:11435/v1");
  assert.equal(normalizeBaseUrl("https://box.lan:443/v1/"), "https://box.lan/v1");
  assert.equal(endpointApiRoot("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(hostSlug("192.168.1.50"), "192-168-1-50");
  assert.throws(() => normalizeBaseUrl("http://user:pass@box"), /credentials/);
  assert.throws(() => normalizeBaseUrl("http://box?q=1"), /query/);
  assert.throws(() => normalizeBaseUrl("ftp://box"), /http or https/);
});

test("host wins, endpoint/model prefix resolves only without explicit endpoint", () => {
  const config = normalizeConfig({ endpoints: { local: { baseUrl: "http://localhost:11434/v1" }, office: { baseUrl: "http://office:11434/v1" } } });
  const host = resolveEndpoint({ config, endpoint: "office", host: "192.168.1.50", model: "bonsai-2:9b" });
  assert.equal(host.providerName, "pi-connector-192-168-1-50");
  const prefixed = resolveEndpoint({ config, model: "office/qwen2.5-coder" });
  assert.equal(prefixed.endpoint, "office");
  assert.equal(prefixed.model, "qwen2.5-coder");
  const explicit = resolveEndpoint({ config, endpoint: "local", model: "office/qwen2.5-coder" });
  assert.equal(explicit.model, "office/qwen2.5-coder");
});
