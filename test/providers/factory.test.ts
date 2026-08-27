import { describe, expect, test } from "bun:test";
import {
  defaultApiKeyEnv,
  defaultBaseUrl,
  ProviderConfigSchema,
} from "../../src/config/schema.ts";
import { DEFAULT_CONTEXT_WINDOW } from "../../src/core/types.ts";
import {
  AnthropicProvider,
  createProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  ProviderConfigError,
} from "../../src/core/provider/index.ts";

const cfg = (over: Record<string, unknown> = {}) => ProviderConfigSchema.parse(over);

describe("createProvider", () => {
  test("defaults to Anthropic", () => {
    expect(createProvider(cfg(), {})).toBeInstanceOf(AnthropicProvider);
  });

  test("anthropic works without an API key so an ant profile can resolve it", () => {
    expect(() => createProvider(cfg({ kind: "anthropic" }), {})).not.toThrow();
  });

  test("openai reads OPENAI_API_KEY by default", () => {
    const p = createProvider(cfg({ kind: "openai" }), { OPENAI_API_KEY: "sk-x" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe("openai");
  });

  test("apiKeyEnv redirects which variable is read", () => {
    const p = createProvider(
      cfg({ kind: "openai", apiKeyEnv: "MY_KEY" }),
      { MY_KEY: "sk-y" },
    );
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  test("openai-compatible demands a baseUrl and says why", () => {
    expect(() => createProvider(cfg({ kind: "openai-compatible" }), {})).toThrow(
      ProviderConfigError,
    );
    expect(() => createProvider(cfg({ kind: "openai-compatible" }), {})).toThrow(
      /requires provider\.baseUrl/,
    );
  });

  test("openai-compatible accepts a local endpoint with no key", () => {
    const p = createProvider(
      cfg({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" }),
      {},
    );
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  test("minimax uses its hosted compatible endpoint and API key", () => {
    expect(defaultBaseUrl("minimax")).toBe("https://api.minimax.io/v1");
    expect(defaultApiKeyEnv("minimax")).toBe("MINIMAX_API_KEY");
    const p = createProvider(cfg({ kind: "minimax" }), { MINIMAX_API_KEY: "mm-x" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe("minimax");
    expect(p.contextWindow("MiniMax-M2.7")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("ollama needs no key and defaults to localhost", () => {
    const p = createProvider(cfg({ kind: "ollama" }), {});
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(p.pricing("qwen3:8b")).toEqual({ input: 0, output: 0 });
  });

  test("contextWindow and pricing overrides reach the provider", () => {
    const p = createProvider(
      cfg({
        kind: "openai",
        contextWindow: 400_000,
        pricing: { input: 1e-6, output: 2e-6 },
      }),
      { OPENAI_API_KEY: "k" },
    );
    expect(p.contextWindow("gpt-5")).toBe(400_000);
    expect(p.pricing("gpt-5")).toEqual({ input: 1e-6, output: 2e-6 });
  });

  test("unknown context windows fall back to the shared default", () => {
    // 126k, just under a real 128k window so compaction fires before the edge.
    for (const kind of ["ollama", "openai"] as const) {
      const p = createProvider(cfg({ kind }), { OPENAI_API_KEY: "k" });
      expect(p.contextWindow("some-model")).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(DEFAULT_CONTEXT_WINDOW).toBe(126_000);
    }
  });
});
