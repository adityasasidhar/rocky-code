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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "./atomic.ts";
import { defaultApiKeyEnv, type ProviderConfig } from "./schema.ts";
import { rockyHome } from "./write.ts";

export type CredentialStore = Record<string, string>;

/** An existing credential store cannot be safely changed when it is corrupt. */
export class CredentialStoreError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CredentialStoreError";
  }
}

export const credentialsPath = (): string =>
  join(rockyHome(), ".rocky", "credentials.json");

/** 0600 file inside a 0700 directory — the mode is half of what makes this safe. */
const writeStore = (path: string, store: CredentialStore): void =>
  writeFileAtomic(path, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });

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

/**
 * Mutation must be stricter than lookup. A session can continue without a key
 * when the store is corrupt, but treating an existing unreadable file as `{}`
 * and writing it back would erase every credential it held.
 */
function readStoreForMutation(path: string): CredentialStore {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CredentialStoreError(path, "cannot read existing credential store");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialStoreError(path, "invalid JSON in existing credential store");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialStoreError(path, "expected existing credential store to be a JSON object");
  }

  const store: CredentialStore = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new CredentialStoreError(path, `invalid credential value for "${name}"`);
    }
    store[name] = value;
  }
  return store;
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
 * Persist one key. Written through a temp file and a rename, under the same
 * lock the delete path takes: two sessions storing keys at once must not each
 * write back the store they read and lose the other's.
 */
export function writeCredential(
  name: string,
  key: string,
  path: string = credentialsPath(),
): void {
  withFileLock(path, () => {
    const store = readStoreForMutation(path);
    store[name] = key;
    writeStore(path, store);
  }, { dirMode: 0o700 });
}

/**
 * Returns whether anything was removed, so callers can report honestly.
 *
 * "Honestly" is the whole contract here: a failure to remove the file must not
 * come back as `true`, because the caller then tells someone their key is gone
 * while it is still on disk. Unlinking is preferred, but an empty store is
 * equally safe — and if neither succeeds, the error propagates.
 */
export function deleteCredential(name: string, path: string = credentialsPath()): boolean {
  return withFileLock(path, () => {
    const store = readStoreForMutation(path);
    if (!(name in store)) return false;
    delete store[name];
    if (Object.keys(store).length === 0) {
      try {
        unlinkSync(path);
      } catch {
        writeStore(path, store);
      }
      return true;
    }
    writeStore(path, store);
    return true;
  }, { dirMode: 0o700 });
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
