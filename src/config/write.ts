/**
 * The only writer of a Rocky config file.
 *
 * `/provider add` has to persist, or "register a provider" would mean nothing
 * past the current session. Writing goes to the *global* config
 * (`~/.config/rocky/config.json`) rather than the project's `.rocky/config.json`
 * on purpose: a provider is a property of the person, not of the checkout, and
 * `.rocky/` is gitignored per-project so a project write would be invisible
 * everywhere else.
 *
 * The file is read as raw JSON, mutated, and written back — unknown keys and
 * key order survive, because this file is hand-edited far more often than it is
 * written by us.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "./load.ts";

export const globalConfigPath = (): string =>
  join(homedir(), ".config", "rocky", "config.json");

/** Keys that would put a live secret in a file meant to be shareable. */
const SECRET_KEYS = new Set(["apikey", "apisecret", "token", "key", "secret", "password"]);

/**
 * Refuse to write a literal credential. `apiKeyEnv` (a variable *name*) is
 * fine; `apiKey` (a value) is the mistake this catches — and it catches it
 * before the write, not in review.
 */
function assertNoSecrets(value: unknown, trail: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, [...trail, String(i)]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase()) && typeof child === "string") {
      throw new ConfigError(
        [...trail, key].join("."),
        "refusing to write a literal secret to the config file; " +
          "name an environment variable with apiKeyEnv, or store the key with /provider add",
      );
    }
    assertNoSecrets(child, [...trail, key]);
  }
}

export type RawConfig = Record<string, unknown>;

export function readRawConfig(path: string = globalConfigPath()): RawConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(path, `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(path, "expected a JSON object");
  }
  return parsed as RawConfig;
}

/**
 * Read → mutate → write, returning the path written so the caller can show it.
 * The mutator receives (and returns) raw JSON, not a parsed `Config`: writing
 * back a parsed config would materialize every default into the user's file.
 */
export function updateGlobalConfig(
  mutate: (raw: RawConfig) => RawConfig,
  path: string = globalConfigPath(),
): string {
  const next = mutate(readRawConfig(path));
  assertNoSecrets(next);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}
