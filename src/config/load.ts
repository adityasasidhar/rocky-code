import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type Config } from "./schema.ts";

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

export type LoadedConfig = { config: Config; sources: string[] };

/**
 * Precedence (low → high): defaults, ~/.config/rocky/config.json,
 * <project>/.rocky/config.json, explicit overrides (CLI flags).
 */
export function loadConfig(
  projectDir: string,
  overrides: Record<string, unknown> = {},
): LoadedConfig {
  const candidates = [
    join(homedir(), ".config", "rocky", "config.json"),
    join(projectDir, ".rocky", "config.json"),
  ];

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
