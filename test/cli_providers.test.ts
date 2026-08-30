import { describe, expect, test } from "bun:test";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import type { Catalog } from "../src/config/catalog.ts";
import {
  ProviderNotFound,
  configuredProviders,
  modelsList,
  providersList,
} from "../src/cli_providers.ts";
import { stripAnsi } from "../src/tui/ansi.ts";

const CATALOG = {
  minimax: {
    id: "minimax",
    name: "MiniMax (minimax.io)",
    npm: "@ai-sdk/anthropic",
    env: ["MINIMAX_API_KEY"],
    models: { "MiniMax-M3": { id: "MiniMax-M3", limit: { context: 1048576 } } },
  },
  groq: {
    id: "groq",
    name: "Groq",
    npm: "@ai-sdk/groq",
    env: ["GROQ_API_KEY"],
    models: { "llama-3.3": { id: "llama-3.3" } },
  },
} as unknown as Catalog;

const withProvider = (): Config => {
  const config = defaultConfig();
  config.providers["minimax"] = {
    kind: "anthropic",
    reasoningEffort: false,
    catalogId: "minimax",
    model: "MiniMax-M3",
  };
  config.activeProvider = "minimax";
  return config;
};

describe("configuredProviders", () => {
  test("a registered provider counts as configured", () => {
    expect(configuredProviders(withProvider(), CATALOG, {}).map((p) => p.id)).toEqual(["minimax"]);
  });

  test("so does one whose credential variable is exported", () => {
    const ids = configuredProviders(defaultConfig(), CATALOG, {
      MINIMAX_API_KEY: "x",
    }).map((p) => p.id);
    expect(ids).toEqual(["minimax"]);
  });

  test("an undrivable provider never counts, however its key is set", () => {
    // Groq's SDK is @ai-sdk/groq, which Rocky has no equivalent for.
    expect(configuredProviders(defaultConfig(), CATALOG, { GROQ_API_KEY: "x" })).toEqual([]);
  });

  test("nothing registered and nothing exported means nothing configured", () => {
    expect(configuredProviders(defaultConfig(), CATALOG, {})).toEqual([]);
  });
});

describe("rocky models", () => {
  test("lists configured providers as provider/model, like opencode", () => {
    expect(modelsList(withProvider(), CATALOG, undefined, false, {})).toBe("minimax/MiniMax-M3");
  });

  test("verbose adds the metadata the catalog carries", () => {
    const line = stripAnsi(modelsList(withProvider(), CATALOG, "minimax", true, {}));
    expect(line).toContain("1048576 ctx");
  });

  test("an unconfigured provider raises, matching opencode's wording", () => {
    expect(() => modelsList(defaultConfig(), CATALOG, "minimax", false, {})).toThrow(
      ProviderNotFound,
    );
    expect(() => modelsList(defaultConfig(), CATALOG, "minimax", false, {})).toThrow(
      "Provider not found: minimax",
    );
  });

  test("with nothing configured it says how to fix that", () => {
    expect(modelsList(defaultConfig(), CATALOG, undefined, false, {})).toContain(
      "no providers configured",
    );
  });
});

describe("rocky providers list", () => {
  const render = (config: Config, env: Record<string, string | undefined>) =>
    stripAnsi(providersList(config, CATALOG, { env, credentialsPath: "/nonexistent" }));

  test("renders both of opencode's panels", () => {
    const out = render(withProvider(), { MINIMAX_API_KEY: "x" });
    expect(out).toContain("Credentials");
    expect(out).toContain("Environment");
    expect(out).toContain("MiniMax (minimax.io)");
  });

  test("an empty registry says how to fill it", () => {
    expect(render(defaultConfig(), {})).toContain("nothing registered");
    expect(render(defaultConfig(), {})).toContain("no provider variables set");
  });

  test("an exported key for an undrivable provider is shown but qualified", () => {
    const out = render(defaultConfig(), { GROQ_API_KEY: "x" });
    expect(out).toContain("Groq");
    expect(out).toContain("needs @ai-sdk/groq");
  });

  test("counts each panel, as opencode does", () => {
    const out = render(withProvider(), { MINIMAX_API_KEY: "x" });
    expect(out).toContain("1 credentials");
    expect(out).toContain("1 environment variable");
  });
});
