import { URL } from "node:url";

function rejectUrlParts(url, input) {
  if (url.username || url.password) throw new Error(`Endpoint host must not contain credentials: "${input}".`);
  if (url.search || url.hash) throw new Error(`Endpoint host must not contain a query or fragment: "${input}".`);
  if (!url.hostname) throw new Error(`Endpoint host is missing: "${input}".`);
  if (!url.port && url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported endpoint scheme in "${input}".`);
}

export function normalizeBaseUrl(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Endpoint URL must be a non-empty string.");
  const value = input.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid endpoint URL "${input}".`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`Endpoint must use http or https: "${input}".`);
  rejectUrlParts(url, input);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") pathname = "/v1";
  else if (!pathname.endsWith("/v1")) pathname = `${pathname}/v1`;
  return `${url.protocol}//${url.host}${pathname}`;
}

export function endpointApiRoot(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.replace(/\/v1$/, "");
}

export function hostSlug(input) {
  let value = String(input).trim();
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    value = url.host;
  } else {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/, 1)[0];
  }
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "endpoint";
}

export function endpointSlug(name, baseUrl, adHoc = false) {
  return adHoc ? hostSlug(baseUrl) : String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || hostSlug(baseUrl);
}

export function resolveEndpoint({ config, endpoint, host, model } = {}) {
  const endpoints = config?.endpoints ?? {};
  let modelValue = model == null ? config?.defaultModel : String(model).trim();
  let selectedName = null;
  let adHoc = false;
  let baseUrl;

  if (host != null && String(host).trim()) {
    adHoc = true;
    baseUrl = normalizeBaseUrl(host);
  } else {
    let selected = endpoint == null || !String(endpoint).trim() ? config?.defaultEndpoint : String(endpoint).trim();
    if (modelValue && !endpoint && modelValue.includes("/")) {
      const prefix = modelValue.slice(0, modelValue.indexOf("/"));
      if (endpoints[prefix]) {
        selected = prefix;
        modelValue = modelValue.slice(prefix.length + 1);
      }
    }
    if (!endpoints[selected]) throw new Error(`Unknown endpoint "${selected}". Configure it or pass host.`);
    selectedName = selected;
    baseUrl = normalizeBaseUrl(endpoints[selected].baseUrl);
  }

  if (!modelValue) throw new Error("A model is required.");
  if (modelValue.length > 300 || /[\r\n]/.test(modelValue)) throw new Error("Model name is invalid.");
  const slug = endpointSlug(selectedName ?? host, baseUrl, adHoc);
  return {
    endpoint: selectedName ?? host,
    host: host ?? null,
    baseUrl,
    apiRoot: endpointApiRoot(baseUrl),
    model: modelValue,
    slug,
    providerName: `pi-connector-${slug}`,
    adHoc,
  };
}

export function configuredEndpoints(config) {
  return Object.entries(config.endpoints).map(([name, value]) => resolveEndpoint({ config, endpoint: name, model: config.defaultModel }));
}
