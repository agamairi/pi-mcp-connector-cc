import fs from "node:fs";
import path from "node:path";

export const MANAGED_PREFIX = "pi-connector-";

function stable(value) {
  return JSON.stringify(value);
}

export function providerNameForSlug(slug) {
  return `${MANAGED_PREFIX}${slug}`;
}

export function readModelsJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("models.json must contain an object.");
    return { value, raw, exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: {}, raw: null, exists: false };
    throw new Error(`Unable to read ${file}: ${error.message}`);
  }
}

export function mergeManagedProviders(file, providers, { backupFile = `${file}.pi-connector.bak` } = {}) {
  const current = readModelsJson(file);
  const next = { ...current.value, providers: { ...(current.value.providers ?? {}) } };
  let changed = false;
  for (const [name, provider] of Object.entries(providers ?? {})) {
    if (!name.startsWith(MANAGED_PREFIX)) throw new Error(`Refusing to manage provider outside ${MANAGED_PREFIX}: ${name}`);
    if (stable(next.providers[name]) !== stable(provider)) {
      next.providers[name] = provider;
      changed = true;
    }
  }
  if (!changed) return { changed: false, file, backupFile, value: current.value };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (current.exists && !fs.existsSync(backupFile)) fs.writeFileSync(backupFile, current.raw, "utf8");
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
  return { changed: true, file, backupFile, value: next };
}

export function managedProviders(value) {
  return Object.fromEntries(Object.entries(value?.providers ?? {}).filter(([name]) => name.startsWith(MANAGED_PREFIX)));
}
