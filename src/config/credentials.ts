/**
 * API keys registered at runtime by `/provider add`.
 *
 * Config files stay secret-free — that rule does not bend. Keys live here
 * instead: a separate `~/.rocky/credentials.json`, mode 0600, holding nothing
 * but `{ "<provider name>": "<key>" }`. The split is what lets a config file
 * be pasted into an issue, committed, or synced without leaking anything, and
 * it matches the precedent already set by the broker's 0600 bearer token.
 *
 * An environment variable always wins over a stored key. Someone who exports
 * `OPENAI_API_KEY` for a single run must not be silently overridden by a value
 * they saved months ago.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultApiKeyEnv, type ProviderConfig } from "./schema.ts";

export type CredentialStore = Record<string, string>;

export const credentialsPath = (): string =>
  join(homedir(), ".rocky", "credentials.json");

/** Unreadable or corrupt is treated as empty: a bad file must not stop a session. */
export function readCredentials(path: string = credentialsPath()): CredentialStore {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: CredentialStore = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readCredential(
  name: string,
  path: string = credentialsPath(),
): string | undefined {
  return readCredentials(path)[name];
}

export function credentialNames(path: string = credentialsPath()): string[] {
  return Object.keys(readCredentials(path)).sort();
}

/**
 * Persist one key. The mode is set on the directory, on creation, *and* with an
 * explicit chmod — `writeFileSync`'s mode is ignored when the file already
 * exists, and a 0644 credentials file is the whole bug this guards against.
 */
export function writeCredential(
  name: string,
  key: string,
  path: string = credentialsPath(),
): void {
  const store = readCredentials(path);
  store[name] = key;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Returns whether anything was removed, so callers can report honestly. */
export function deleteCredential(name: string, path: string = credentialsPath()): boolean {
  const store = readCredentials(path);
  if (!(name in store)) return false;
  delete store[name];
  if (Object.keys(store).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort; an empty object below is equally safe.
    }
    return true;
  }
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

export type KeySource = "env" | "stored" | "none";

/**
 * Where this provider's key comes from, without ever returning to the caller a
 * reason to print the value. `/provider list`, `/info`, and `doctor` all render
 * from `source`; only `createProvider` reads `key`.
 */
export function resolveApiKey(
  cfg: Pick<ProviderConfig, "kind" | "apiKeyEnv">,
  opts: {
    /** Registry name, for the stored-credential lookup. Unnamed providers skip it. */
    name?: string | undefined;
    env?: Record<string, string | undefined>;
    path?: string;
  } = {},
): { key: string | undefined; source: KeySource; envVar: string | undefined } {
  const envVar = cfg.apiKeyEnv ?? defaultApiKeyEnv(cfg.kind);
  const env = opts.env ?? process.env;
  const fromEnv = envVar ? env[envVar] : undefined;
  if (fromEnv) return { key: fromEnv, source: "env", envVar };

  const stored = opts.name
    ? readCredential(opts.name, opts.path ?? credentialsPath())
    : undefined;
  if (stored) return { key: stored, source: "stored", envVar };

  return { key: undefined, source: "none", envVar };
}
