import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const writeProjectConfig = (obj: unknown) => {
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "config.json"), JSON.stringify(obj), "utf8");
};

describe("loadConfig", () => {
  test("returns defaults when nothing is configured", () => {
    const { config, sources } = loadConfig(dir);
    expect(sources).toEqual([]);
    expect(config.model).toBe("claude-opus-4-8");
    expect(config.provider.kind).toBe("anthropic");
    expect(config.backend).toBe("trueforge");
    expect(config.trueforge.baseUrl).toBe("http://127.0.0.1:8790");
    expect(config.permissionMode).toBe("ask");
  });

  test("project config overrides defaults", () => {
    writeProjectConfig({ model: "claude-sonnet-5", maxTokens: 8000 });
    const { config, sources } = loadConfig(dir);
    expect(config.model).toBe("claude-sonnet-5");
    expect(config.maxTokens).toBe(8000);
    expect(sources).toHaveLength(1);
  });

  test("CLI overrides beat the project config", () => {
    writeProjectConfig({ model: "a" });
    expect(loadConfig(dir, { model: "b" }).config.model).toBe("b");
  });

  test("a provider override merges rather than replacing the whole object", () => {
    // The regression this guards: `--provider ollama` must not discard baseUrl.
    writeProjectConfig({
      provider: { kind: "openai", baseUrl: "http://example.com/v1", think: true },
    });
    const { config } = loadConfig(dir, { provider: { kind: "ollama" } });

    expect(config.provider.kind).toBe("ollama");
    expect(config.provider.baseUrl).toBe("http://example.com/v1");
    expect(config.provider.think).toBe(true);
  });

  test("malformed JSON names the file", () => {
    mkdirSync(join(dir, ".rocky"), { recursive: true });
    writeFileSync(join(dir, ".rocky", "config.json"), "{ not json", "utf8");
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/invalid JSON/);
  });

  test("a non-object config is rejected", () => {
    writeProjectConfig([1, 2, 3]);
    expect(() => loadConfig(dir)).toThrow(/expected a JSON object/);
  });

  test("an invalid value reports the offending field", () => {
    writeProjectConfig({ effort: "turbo" });
    expect(() => loadConfig(dir)).toThrow(/effort/);
  });

  test("maxTokens above the API ceiling is rejected", () => {
    writeProjectConfig({ maxTokens: 999_999 });
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  test("an unknown provider kind is rejected at the boundary", () => {
    writeProjectConfig({ provider: { kind: "gemini" } });
    expect(() => loadConfig(dir)).toThrow(/provider.kind/);
  });

  test("worker images must be pinned", () => {
    writeProjectConfig({
      broker: { workers: { codex: { kind: "codex", image: "rocky-worker-codex:latest" } } },
    });
    expect(() => loadConfig(dir)).toThrow(/explicit version tag/);
  });

  test("worker images without a version tag are not considered pinned", () => {
    writeProjectConfig({
      broker: {
        workers: { codex: { enabled: true, kind: "codex", image: "rocky-worker-codex" } },
      },
    });
    expect(() => loadConfig(dir)).toThrow(/explicit version tag/);
  });
});

describe("defaultConfig", () => {
  test("parses cleanly and is stable", () => {
    expect(defaultConfig()).toEqual(defaultConfig());
    expect(defaultConfig().provider.reasoningEffort).toBe(false);
    // Left unset on purpose: an absent `think` lets the provider's capability
    // probe decide. An explicit `false` would override what the model reports.
    expect(defaultConfig().provider.think).toBeUndefined();
  });
});
