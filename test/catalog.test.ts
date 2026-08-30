import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOG_URL,
  SEED_CATALOG,
  catalogModels,
  catalogProviders,
  isSupported,
  kindFor,
  loadCatalog,
  providerConfigFrom,
  unsupportedReason,
  type Catalog,
  type CatalogProvider,
} from "../src/config/catalog.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const FIXTURE = {
  minimax: {
    id: "minimax",
    name: "MiniMax (minimax.io)",
    api: "https://api.minimax.io/anthropic/v1",
    npm: "@ai-sdk/anthropic",
    env: ["MINIMAX_API_KEY"],
    doc: "https://platform.minimax.io/docs",
    models: {
      "MiniMax-M3": {
        id: "MiniMax-M3",
        name: "MiniMax-M3",
        limit: { context: 204800, output: 131072 },
        cost: { input: 0.3, output: 1.2 },
        reasoning: true,
        tool_call: true,
      },
      "MiniMax-M2": { id: "MiniMax-M2", limit: { context: 204800 } },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    api: "https://api.groq.com/openai/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["GROQ_API_KEY"],
    models: { "llama-3.3-70b": { id: "llama-3.3-70b" } },
  },
  bedrock: {
    id: "bedrock",
    name: "Amazon Bedrock",
    npm: "@ai-sdk/amazon-bedrock",
    env: ["AWS_ACCESS_KEY_ID"],
    models: {},
  },
};

const fakeFetch = (body: unknown, ok = true): typeof fetch =>
  (async () =>
    ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

const failingFetch: typeof fetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("npm → provider kind", () => {
  test("maps the three SDKs Rocky can drive", () => {
    expect(kindFor("@ai-sdk/openai-compatible")).toBe("openai-compatible");
    expect(kindFor("@ai-sdk/anthropic")).toBe("anthropic");
    expect(kindFor("@ai-sdk/openai")).toBe("openai");
  });

  test("everything else is unsupported rather than guessed at", () => {
    expect(kindFor("@ai-sdk/amazon-bedrock")).toBeUndefined();
    expect(kindFor("@ai-sdk/google-vertex")).toBeUndefined();
    expect(kindFor(undefined)).toBeUndefined();
  });

  test("the unsupported message names the SDK, so the gap is explainable", () => {
    const reason = unsupportedReason(FIXTURE.bedrock as CatalogProvider);
    expect(reason).toContain("Amazon Bedrock");
    expect(reason).toContain("@ai-sdk/amazon-bedrock");
  });
});

describe("providerConfigFrom", () => {
  test("fills endpoint, credential variable, window, and price from one pick", () => {
    const config = providerConfigFrom(FIXTURE.minimax as CatalogProvider, "MiniMax-M3");
    expect(config).toEqual({
      kind: "anthropic",
      baseUrl: "https://api.minimax.io/anthropic/v1",
      apiKeyEnv: "MINIMAX_API_KEY",
      contextWindow: 204800,
      // models.dev quotes $/million; Rocky accounts per token.
      pricing: { input: 0.3 / 1_000_000, output: 1.2 / 1_000_000 },
    });
  });

  test("omits pricing a model does not publish rather than inventing zero", () => {
    const config = providerConfigFrom(FIXTURE.minimax as CatalogProvider, "MiniMax-M2");
    expect(config?.contextWindow).toBe(204800);
    expect(config?.pricing).toBeUndefined();
  });

  test("returns nothing for a provider Rocky cannot drive", () => {
    expect(providerConfigFrom(FIXTURE.bedrock as CatalogProvider)).toBeUndefined();
  });

  test("a provider with no endpoint of its own leaves baseUrl to the SDK", () => {
    const anthropic = { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: [], models: {} };
    expect(providerConfigFrom(anthropic)).toEqual({ kind: "anthropic" });
  });
});

describe("loadCatalog", () => {
  const path = () => join(dir, "models.json");

  test("fetches, parses, and caches", async () => {
    const { catalog, source } = await loadCatalog({
      path: path(),
      fetchImpl: fakeFetch(FIXTURE),
    });
    expect(source).toBe("network");
    expect(Object.keys(catalog).sort()).toEqual(["bedrock", "groq", "minimax"]);
    expect(catalog["minimax"]?.models["MiniMax-M3"]?.limit?.context).toBe(204800);
    expect(Object.keys(JSON.parse(readFileSync(path(), "utf8")))).toContain("groq");
  });

  test("a fresh cache short-circuits the network entirely", async () => {
    writeFileSync(path(), JSON.stringify(FIXTURE), "utf8");
    let called = false;
    const spy: typeof fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const { source } = await loadCatalog({ path: path(), fetchImpl: spy });
    expect(source).toBe("cache");
    expect(called).toBe(false);
  });

  test("refresh ignores a fresh cache", async () => {
    writeFileSync(path(), JSON.stringify({ groq: FIXTURE.groq }), "utf8");
    const { catalog, source } = await loadCatalog({
      path: path(),
      refresh: true,
      fetchImpl: fakeFetch(FIXTURE),
    });
    expect(source).toBe("network");
    expect(Object.keys(catalog)).toContain("minimax");
  });

  test("a stale cache is still better than nothing when offline", async () => {
    writeFileSync(path(), JSON.stringify(FIXTURE), "utf8");
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(path(), old, old);

    const { catalog, source } = await loadCatalog({ path: path(), fetchImpl: failingFetch });
    expect(source).toBe("cache");
    expect(Object.keys(catalog)).toContain("minimax");
  });

  test("offline with no cache still yields a usable catalog", async () => {
    const { catalog, source } = await loadCatalog({ path: path(), fetchImpl: failingFetch });
    expect(source).toBe("seed");
    expect(catalog).toEqual(SEED_CATALOG);
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  test("a non-ok response falls back rather than caching junk", async () => {
    const { source } = await loadCatalog({
      path: path(),
      fetchImpl: fakeFetch({ error: "nope" }, false),
    });
    expect(source).toBe("seed");
  });

  test("malformed entries are skipped, not fatal", async () => {
    const { catalog } = await loadCatalog({
      path: path(),
      fetchImpl: fakeFetch({ good: FIXTURE.groq, bad: "not an object", alsoBad: null }),
    });
    expect(Object.keys(catalog)).toEqual(["good"]);
  });

  test("points at models.dev, the same source opencode uses", () => {
    expect(CATALOG_URL).toBe("https://models.dev/api.json");
  });
});

describe("listing", () => {
  const catalog = FIXTURE as unknown as Catalog;

  test("supported providers sort ahead of ones Rocky cannot drive", () => {
    const rows = catalogProviders(catalog);
    expect(rows.map((p) => p.id)).toEqual(["groq", "minimax", "bedrock"]);
    expect(isSupported(rows[0]!)).toBe(true);
    expect(isSupported(rows.at(-1)!)).toBe(false);
  });

  test("models list in a stable order", () => {
    const models = catalogModels(catalog["minimax"]!);
    expect(models.map((m) => m.id)).toEqual(["MiniMax-M2", "MiniMax-M3"]);
  });
});
