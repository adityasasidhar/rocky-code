import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema, type Config } from "./schema.ts";
import { globalConfigPath } from "./write.ts";

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
  }
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(path, `invalid JSON: ${(e as Error).message}`);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Later sources win per top-level key, except `provider`, which merges one
 * level deep — otherwise `--provider ollama` would silently discard a
 * `baseUrl` set in the project config file.
 */
function merge(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out = { ...a, ...b };
  for (const key of ["provider", "trueforge", "broker"] as const) {
    if (isPlainObject(a[key]) && isPlainObject(b[key])) {
      out[key] = { ...a[key], ...b[key] };
    }
  }
  return out;
}

/**
 * Splice the active registry entry into `provider`/`model`.
 *
 * A *replacement*, not a merge: `provider` and a named entry describe two
 * different servers, so inheriting a leftover `baseUrl` or `think` from the
 * one that is not active would point Rocky at the wrong endpoint. Runs before
 * CLI overrides are applied, so `--provider ollama` still wins over a
 * persisted `activeProvider`.
 */
function expandActiveProvider(
  raw: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  const name = raw["activeProvider"];
  if (name === undefined) return raw;
  if (typeof name !== "string") {
    throw new ConfigError(source, "activeProvider must be a string");
  }
  const registry = isPlainObject(raw["providers"]) ? raw["providers"] : {};
  const entry = registry[name];
  if (!isPlainObject(entry)) {
    const known = Object.keys(registry);
    throw new ConfigError(
      source,
      `activeProvider "${name}" is not in providers` +
        (known.length > 0 ? ` (have: ${known.join(", ")})` : " (the registry is empty)"),
    );
  }
  const { model, ...provider } = entry;
  const out: Record<string, unknown> = { ...raw, provider };
  if (typeof model === "string") out["model"] = model;
  return out;
}

export type LoadedConfig = { config: Config; sources: string[] };

/**
 * Whether an override describes a *different service* than the active registry
 * entry does, in which case that entry's identity must not survive it.
 *
 * `--provider` names a kind, never a registry name, so it can only mean "not
 * the one that is active". Letting the entry survive would merge its `baseUrl`
 * into the new kind and leave `activeProvider` pointing at it, so the newly
 * selected provider would be handed the old one's endpoint and its stored key.
 * `--base-url` is milder — same kind, different endpoint — but it is still an
 * endpoint the registry never vouched for, so a key saved for the named
 * provider does not travel to it. An environment variable still does: that one
 * the user is exporting deliberately, per run.
 */
function overridesProviderIdentity(overrides: Record<string, unknown>): {
  replacesEntry: boolean;
  dropsStoredKey: boolean;
} {
  const provider = isPlainObject(overrides["provider"]) ? overrides["provider"] : undefined;
  return {
    replacesEntry: provider?.["kind"] !== undefined,
    dropsStoredKey:
      provider?.["kind"] !== undefined || provider?.["baseUrl"] !== undefined,
  };
}

/**
 * Precedence (low → high): defaults, ~/.config/rocky/config.json,
 * <project>/.rocky/config.json, the active named provider, explicit overrides
 * (CLI flags).
 */
export function loadConfig(
  projectDir: string,
  overrides: Record<string, unknown> = {},
): LoadedConfig {
  const candidates = [globalConfigPath(), join(projectDir, ".rocky", "config.json")];

  let raw: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(path, "expected a JSON object");
    }
    raw = merge(raw, parsed as Record<string, unknown>);
    sources.push(path);
  }

  const { replacesEntry, dropsStoredKey } = overridesProviderIdentity(overrides);
  // Expand first, drop the name second. The entry's kind, credential variable,
  // window and price are wanted; only the *name* is dropped, because the name
  // is the handle a stored credential is looked up by. Dropping it before the
  // expansion would throw the whole entry away and leave `--base-url` pointing
  // Rocky's default provider at someone else's endpoint.
  if (!replacesEntry) raw = expandActiveProvider(raw, sources.at(-1) ?? "<defaults>");
  if (dropsStoredKey) {
    const { activeProvider: _dropped, ...rest } = raw;
    raw = rest;
  }
  raw = merge(raw, overrides);

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(sources.at(-1) ?? "<defaults>", `\n${issues}`);
  }
  return { config: result.data, sources };
}
