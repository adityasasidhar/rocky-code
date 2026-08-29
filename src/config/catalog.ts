/**
 * The models.dev provider catalog — the same data source opencode uses.
 *
 * This is what turns provider registration from an interrogation ("what kind is
 * it? what's the base URL? what's the context window?") into a choice from a
 * list. Each catalog entry already carries the endpoint, the credential
 * variable, every model id, and each model's context limit and price, so
 * picking a provider is enough to configure it.
 *
 * Never a hard failure: the network is tried, then the cache, then a small
 * built-in seed. `/connect` has to work on a plane.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderKind } from "./schema.ts";

export const CATALOG_URL = "https://models.dev/api.json";

/** models.dev quotes cost per million tokens; Rocky's `pricing` is per token. */
const COST_SCALE = 1_000_000;

/** How stale a cached catalog may be before a background refresh is attempted. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export type CatalogModel = {
  id: string;
  name?: string;
  /** Token limits. `context` is what Rocky accounts against. */
  limit?: { context?: number; output?: number };
  /** USD per *million* tokens. Convert before use. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  reasoning?: boolean;
  tool_call?: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  /** Base URL. Taken verbatim as `provider.baseUrl`. */
  api?: string;
  /** The AI-SDK package, which is really a statement of wire protocol. */
  npm?: string;
  /** Credential variables, most-preferred first. */
  env: string[];
  doc?: string;
  models: Record<string, CatalogModel>;
};

export type Catalog = Record<string, CatalogProvider>;

export const catalogCachePath = (): string =>
  join(homedir(), ".cache", "rocky", "models.json");

/**
 * `npm` is the only reliable signal of how to talk to a provider — 167 of the
 * catalog's entries are openai-compatible, and the rest differ by protocol
 * rather than by vendor. Anything not listed here needs an SDK Rocky does not
 * have; `unsupportedReason` explains that rather than hiding the provider.
 */
export function kindFor(npm: string | undefined): ProviderKind | undefined {
  switch (npm) {
    case "@ai-sdk/openai-compatible":
      return "openai-compatible";
    case "@ai-sdk/anthropic":
      return "anthropic";
    case "@ai-sdk/openai":
      return "openai";
    default:
      return undefined;
  }
}

export function unsupportedReason(provider: CatalogProvider): string {
  const sdk = provider.npm ?? "an unknown SDK";
  return (
    `${provider.name} speaks ${sdk}, which Rocky cannot drive yet — it supports ` +
    `Anthropic, OpenAI, OpenAI-compatible, MiniMax, and Ollama endpoints.`
  );
}

export const isSupported = (provider: CatalogProvider): boolean =>
  kindFor(provider.npm) !== undefined;

/**
 * Enough of a catalog to register the endpoints Rocky knows natively, for a
 * first run with no network. Deliberately tiny — it is a floor, not a mirror.
 */
export const SEED_CATALOG: Catalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: {},
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: {},
  },
  minimax: {
    id: "minimax",
    name: "MiniMax (minimax.io)",
    api: "https://api.minimax.io/anthropic/v1",
    npm: "@ai-sdk/anthropic",
    env: ["MINIMAX_API_KEY"],
    models: {},
  },
};

function parseCatalog(raw: unknown): Catalog {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Catalog = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const models: Record<string, CatalogModel> = {};
    if (typeof entry["models"] === "object" && entry["models"] !== null) {
      for (const [modelId, model] of Object.entries(entry["models"] as object)) {
        if (typeof model === "object" && model !== null) {
          models[modelId] = { id: modelId, ...(model as object) } as CatalogModel;
        }
      }
    }
    out[id] = {
      id: typeof entry["id"] === "string" ? entry["id"] : id,
      name: typeof entry["name"] === "string" ? entry["name"] : id,
      ...(typeof entry["api"] === "string" ? { api: entry["api"] } : {}),
      ...(typeof entry["npm"] === "string" ? { npm: entry["npm"] } : {}),
      ...(typeof entry["doc"] === "string" ? { doc: entry["doc"] } : {}),
      env: Array.isArray(entry["env"]) ? entry["env"].filter((e) => typeof e === "string") : [],
      models,
    };
  }
  return out;
}

export type CatalogSource = "network" | "cache" | "seed";
export type LoadedCatalog = { catalog: Catalog; source: CatalogSource };

export type LoadCatalogOptions = {
  /** Bypass the cache and refetch, as `--refresh` does. */
  refresh?: boolean;
  path?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  ttlMs?: number;
};

function readCache(path: string): Catalog | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseCatalog(JSON.parse(readFileSync(path, "utf8")));
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const isFresh = (path: string, ttlMs: number): boolean => {
  try {
    return Date.now() - statSync(path).mtimeMs < ttlMs;
  } catch {
    return false;
  }
};

/**
 * Network → cache → seed. A fresh cache short-circuits the fetch entirely, so
 * the common case costs one stat and one read.
 */
export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<LoadedCatalog> {
  const path = opts.path ?? catalogCachePath();
  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;

  if (!opts.refresh && isFresh(path, ttl)) {
    const cached = readCache(path);
    if (cached) return { catalog: cached, source: "cache" };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const catalog = parseCatalog(await response.json());
      if (Object.keys(catalog).length > 0) {
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(catalog), "utf8");
        } catch {
          // A read-only cache dir must not stop the session; we still have the data.
        }
        return { catalog, source: "network" };
      }
    }
  } catch {
    // Offline, blocked, or slow — fall through to whatever is on disk.
  }

  const stale = readCache(path);
  if (stale) return { catalog: stale, source: "cache" };
  return { catalog: SEED_CATALOG, source: "seed" };
}

export type CatalogProviderConfig = {
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  pricing?: { input: number; output: number };
};

/**
 * The provider config a catalog entry implies. Everything the old wizard asked
 * for by hand — endpoint, credential variable, window, price — comes from here.
 * Returns undefined for a provider whose SDK Rocky cannot drive.
 */
export function providerConfigFrom(
  provider: CatalogProvider,
  modelId?: string,
): CatalogProviderConfig | undefined {
  const kind = kindFor(provider.npm);
  if (!kind) return undefined;

  const model = modelId ? provider.models[modelId] : undefined;
  const context = model?.limit?.context;
  const input = model?.cost?.input;
  const output = model?.cost?.output;

  return {
    kind,
    ...(provider.api ? { baseUrl: provider.api } : {}),
    ...(provider.env[0] ? { apiKeyEnv: provider.env[0] } : {}),
    ...(context ? { contextWindow: context } : {}),
    ...(input !== undefined && output !== undefined
      ? { pricing: { input: input / COST_SCALE, output: output / COST_SCALE } }
      : {}),
  };
}

/** Providers sorted for display: supported first, then alphabetical by name. */
export function catalogProviders(catalog: Catalog): CatalogProvider[] {
  return Object.values(catalog).sort((a, b) => {
    const supported = Number(isSupported(b)) - Number(isSupported(a));
    return supported !== 0 ? supported : a.name.localeCompare(b.name);
  });
}

/** Models of one provider, sorted by id. */
export function catalogModels(provider: CatalogProvider): CatalogModel[] {
  return Object.values(provider.models).sort((a, b) => a.id.localeCompare(b.id));
}
