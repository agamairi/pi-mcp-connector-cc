import { endpointApiRoot, normalizeBaseUrl } from "./endpoints.mjs";

async function requestJson(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}${body?.error ? `: ${body.error}` : ""}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function modelId(model) {
  return model?.name ?? model?.model ?? model?.id ?? null;
}

export function normalizeModels(body) {
  const rows = Array.isArray(body?.models) ? body.models : [];
  return rows.map((row) => ({
    id: modelId(row),
    name: modelId(row),
    size: row.size ?? null,
    digest: row.digest ?? null,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    details: row.details ?? {},
  })).filter((row) => row.id);
}

export async function getOllamaVersion(baseUrl, options = {}) {
  return requestJson(`${endpointApiRoot(normalizeBaseUrl(baseUrl))}/api/version`, {}, options.timeoutMs ?? 5000);
}

export async function listOllamaModels(baseUrl, options = {}) {
  const root = endpointApiRoot(normalizeBaseUrl(baseUrl));
  try {
    return normalizeModels(await requestJson(`${root}/api/tags`, {}, options.timeoutMs ?? 5000));
  } catch (tagsError) {
    const v1 = await requestJson(`${normalizeBaseUrl(baseUrl)}/models`, {}, options.timeoutMs ?? 5000);
    const models = normalizeModels(v1);
    if (models.length) return models;
    throw tagsError;
  }
}

export async function getEffectiveContext(baseUrl, model, options = {}) {
  const root = endpointApiRoot(normalizeBaseUrl(baseUrl));
  let showError = null;
  try {
    const body = await requestJson(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model }),
    }, options.timeoutMs ?? 5000);
    const parameters = String(body?.parameters ?? "");
    const match = /(?:^|\n)\s*num_ctx\s+(\d+)/i.exec(parameters);
    const context = Number(body?.model_info?.context_length ?? body?.details?.context_length ?? match?.[1] ?? 0) || null;
    if (context) return { numCtx: context, source: body?.model_info?.context_length ? "api/show:model_info" : "api/show" };
  } catch (error) {
    showError = error;
  }
  try {
    const body = await requestJson(`${root}/api/ps`, {}, options.timeoutMs ?? 5000);
    const row = (body?.models ?? []).find((item) => modelId(item) === model || item?.name === model);
    const context = Number(row?.context_length ?? row?.details?.context_length ?? row?.model_info?.context_length ?? 0) || null;
    if (context) return { numCtx: context, source: "api/ps" };
  } catch (error) {
    if (!showError) showError = error;
  }
  return { numCtx: null, source: null, warning: showError ? `context unavailable: ${showError.message}` : "context unavailable" };
}

export async function inspectEndpoint(baseUrl, options = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const [version, models] = await Promise.all([
      getOllamaVersion(normalized, options),
      listOllamaModels(normalized, options),
    ]);
    return { reachable: true, baseUrl: normalized, version: version?.version ?? null, models, error: null };
  } catch (error) {
    return { reachable: false, baseUrl: normalized, version: null, models: [], error: error.message };
  }
}

export function providerForModel(target, modelRecord) {
  const capabilities = new Set(modelRecord?.capabilities ?? []);
  return {
    baseUrl: target.baseUrl,
    api: "openai-completions",
    apiKey: "ollama",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: [{
      id: target.model,
      reasoning: capabilities.has("thinking"),
      input: ["text", ...(capabilities.has("vision") ? ["image"] : [])],
      contextWindow: modelRecord?.contextWindow ?? undefined,
      maxTokens: modelRecord?.maxTokens ?? undefined,
    }],
  };
}

export async function resolveOllamaModel(target, options = {}) {
  const models = await listOllamaModels(target.baseUrl, options);
  const found = models.find((item) => item.id === target.model);
  if (!found) {
    const available = models.map((item) => item.id).join(", ") || "(none)";
    throw new Error(`Model "${target.model}" was not reported by ${target.baseUrl}. Available models: ${available}.`);
  }
  const context = await getEffectiveContext(target.baseUrl, target.model, options);
  return { ...target, modelRecord: found, context, models };
}
