/**
 * The effectful half of `/provider`: config writes and credential storage.
 *
 * Split from `src/config/providers.ts` (which is pure) and from `cli.ts` (which
 * owns the session and the backend) so the part that touches two files at once
 * — the config and the credentials store — can be tested against temp paths.
 *
 * Registration always writes both `providers[name]` and `activeProvider`. A
 * provider you just registered but have to activate separately is a papercut
 * with no upside; `/provider use` exists for switching *between* the ones you
 * already have.
 */
import { ProviderConfigSchema, type Config, type ProviderConfig } from "../config/schema.ts";
import {
  credentialsPath,
  deleteCredential,
  resolveApiKey,
  writeCredential,
  type KeySource,
} from "../config/credentials.ts";
import { draftToEntry, type ProviderDraft } from "../config/providers.ts";
import { globalConfigPath, updateGlobalConfig } from "../config/write.ts";
import { createProvider } from "./provider/index.ts";
import type { Provider } from "./types.ts";

export type RegistryPaths = {
  config?: string;
  credentials?: string;
};

const paths = (opts: RegistryPaths = {}) => ({
  config: opts.config ?? globalConfigPath(),
  credentials: opts.credentials ?? credentialsPath(),
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type RegisterResult = {
  /** Where the registry entry landed, so the user can go edit it. */
  configPath: string;
  /** Whether a key was written to the credentials store. */
  stored: boolean;
};

export function registerProvider(
  draft: ProviderDraft,
  secret?: string,
  opts: RegistryPaths = {},
): RegisterResult {
  const p = paths(opts);
  const configPath = updateGlobalConfig((raw) => {
    const registry = isPlainObject(raw["providers"]) ? { ...raw["providers"] } : {};
    registry[draft.name] = draftToEntry(draft);
    return { ...raw, providers: registry, activeProvider: draft.name };
  }, p.config);

  if (secret !== undefined && secret !== "") {
    writeCredential(draft.name, secret, p.credentials);
  }
  return { configPath, stored: secret !== undefined && secret !== "" };
}

/**
 * Change which model a registered provider defaults to, without disturbing the
 * rest of its entry. `/models` switching a model must not rewrite the endpoint
 * or credential variable that were resolved when it was registered.
 */
export function setRegistryModel(
  name: string,
  model: string,
  opts: RegistryPaths = {},
): string {
  return updateGlobalConfig((raw) => {
    const registry = isPlainObject(raw["providers"]) ? { ...raw["providers"] } : {};
    const entry = registry[name];
    if (!isPlainObject(entry)) return raw;
    registry[name] = { ...entry, model };
    return { ...raw, providers: registry, activeProvider: name };
  }, paths(opts).config);
}

/** Point `activeProvider` at an already-registered name. */
export function activateProvider(name: string, opts: RegistryPaths = {}): string {
  return updateGlobalConfig((raw) => ({ ...raw, activeProvider: name }), paths(opts).config);
}

export type ForgetResult = {
  configPath: string;
  removedKey: boolean;
  /** True when the removed provider was the active one. */
  wasActive: boolean;
};

/**
 * Remove the entry *and* its stored key. Leaving an orphaned credential behind
 * would be a secret nobody remembers having, which is the worst kind.
 */
export function forgetProvider(name: string, opts: RegistryPaths = {}): ForgetResult {
  const p = paths(opts);
  let wasActive = false;
  const configPath = updateGlobalConfig((raw) => {
    const registry = isPlainObject(raw["providers"]) ? { ...raw["providers"] } : {};
    delete registry[name];
    const next: Record<string, unknown> = { ...raw, providers: registry };
    if (raw["activeProvider"] === name) {
      wasActive = true;
      delete next["activeProvider"];
    }
    return next;
  }, p.config);

  return { configPath, removedKey: deleteCredential(name, p.credentials), wasActive };
}

/**
 * The provider config a registry entry resolves to. `model` is stripped: it
 * belongs to the session, not to the transport.
 */
export function entryToProviderConfig(entry: Record<string, unknown>): ProviderConfig {
  const { model: _model, ...rest } = entry;
  return ProviderConfigSchema.parse(rest);
}

/** Build a live provider for a registry entry, honouring env-over-stored keys. */
export function providerFor(
  cfg: ProviderConfig,
  name: string | undefined,
  opts: RegistryPaths = {},
): { provider: Provider; source: KeySource; envVar: string | undefined } {
  const resolved = resolveApiKey(cfg, {
    name,
    ...(opts.credentials ? { path: opts.credentials } : {}),
  });
  const provider = createProvider(
    cfg,
    process.env,
    ...(resolved.key === undefined ? [] : ([resolved.key] as const)),
  );
  return { provider, source: resolved.source, envVar: resolved.envVar };
}

/** Where the running session's key comes from, for `/provider` and `/info`. */
export function activeKeySource(
  config: Config,
  opts: RegistryPaths = {},
): { source: KeySource; envVar: string | undefined } {
  const { source, envVar } = resolveApiKey(config.provider, {
    name: config.activeProvider,
    ...(opts.credentials ? { path: opts.credentials } : {}),
  });
  return { source, envVar };
}
