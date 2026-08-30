import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config/schema.ts";
import { readCredential, writeCredential } from "../src/config/credentials.ts";
import { readRawConfig } from "../src/config/write.ts";
import { Session } from "../src/core/session.ts";
import type { ProviderCommandCtx } from "../src/core/provider_command.ts";
import {
  CUSTOM,
  OLLAMA_LOCAL,
  allModelItems,
  connectItems,
  modelItems,
  runConnect,
  runModels,
} from "../src/core/connect_command.ts";
import type { Catalog, CatalogProvider, LoadedCatalog } from "../src/config/catalog.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const CATALOG = {
  minimax: {
    id: "minimax",
    name: "MiniMax (minimax.io)",
    api: "https://api.minimax.io/anthropic/v1",
    npm: "@ai-sdk/anthropic",
    env: ["MINIMAX_API_KEY"],
    models: {
      "MiniMax-M3": {
        id: "MiniMax-M3",
        limit: { context: 1048576 },
        cost: { input: 0.3, output: 1.2 },
        reasoning: true,
      },
      "MiniMax-M2": { id: "MiniMax-M2", limit: { context: 204800 } },
    },
  },
  bedrock: {
    id: "bedrock",
    name: "Amazon Bedrock",
    npm: "@ai-sdk/amazon-bedrock",
    env: ["AWS_ACCESS_KEY_ID"],
    models: { "claude-x": { id: "claude-x" } },
  },
} as unknown as Catalog;

type Harness = ProviderCommandCtx & {
  output: () => string;
  /** Prompts the fake UI was shown, in order, for asserting the flow. */
  asked: string[];
};

/**
 * A scripted UI: each `select`/`prompt` call takes the next answer. `undefined`
 * in the script stands for the user pressing Esc.
 */
function harness(answers: (string | undefined)[], tags: string[] = []): Harness {
  const session = new Session({
    cwd: dir,
    config: defaultConfig(),
    provider: new MockProvider([]),
    projectDir: dir,
  });
  const lines: string[] = [];
  const asked: string[] = [];
  const script = [...answers];

  const fetchImpl = (async () => ({
    ok: true,
    json: async () => ({ models: tags.map((name) => ({ name })) }),
  })) as unknown as typeof fetch;

  return {
    session,
    backendKind: () => "local",
    switchToLocal: () => undefined,
    out: (line) => lines.push(line),
    wizard: { active: null },
    paths: { config: join(dir, "config.json"), credentials: join(dir, "credentials.json") },
    ui: {
      async select(opts) {
        asked.push(opts.title);
        return script.shift();
      },
      async prompt(opts) {
        asked.push(opts.title);
        return script.shift();
      },
    },
    loadCatalog: async (): Promise<LoadedCatalog> => ({ catalog: CATALOG, source: "cache" }),
    fetchImpl,
    output: () => lines.join("\n"),
    asked,
  };
}

describe("connectItems", () => {
  const items = connectItems(CATALOG);

  test("leads with the rows the catalog cannot supply", () => {
    expect(items[0]?.value).toBe(OLLAMA_LOCAL);
    expect(items[0]?.label).toBe("Ollama (local)");
    expect(items[1]?.value).toBe(CUSTOM);
    expect(items[1]?.label).toBe("Other");
  });

  test("a supported provider advertises its model count", () => {
    const minimax = items.find((i) => i.value === "minimax");
    expect(minimax?.label).toBe("MiniMax (minimax.io)");
    expect(minimax?.hint).toBe("2 models");
    expect(minimax?.disabled).toBeUndefined();
  });

  test("an undrivable provider is listed but disabled, with the reason attached", () => {
    const bedrock = items.find((i) => i.value === "bedrock");
    expect(bedrock).toBeDefined();
    expect(bedrock?.disabled).toBe(true);
    expect(bedrock?.disabledReason).toContain("@ai-sdk/amazon-bedrock");
  });
});

describe("modelItems", () => {
  test("shows context and price so the choice is informed", () => {
    const items = modelItems(CATALOG["minimax"] as CatalogProvider);
    const m3 = items.find((i) => i.value === "MiniMax-M3");
    expect(m3?.hint).toContain("1049k ctx");
    expect(m3?.hint).toContain("$0.3/$1.2 per Mtok");
    expect(m3?.hint).toContain("reasoning");
  });

  test("a model with no published cost simply omits it", () => {
    const items = modelItems(CATALOG["minimax"] as CatalogProvider);
    expect(items.find((i) => i.value === "MiniMax-M2")?.hint).toBe("205k ctx");
  });
});

describe("/connect", () => {
  test("provider → model → API key registers everything the catalog knows", async () => {
    const ctx = harness(["minimax", "MiniMax-M3", "trust", "api", "sk-super-secret"]);
    await runConnect(ctx);

    expect(ctx.asked).toEqual([
      "Add provider",
      "MiniMax (minimax.io) · model",
      "MiniMax (minimax.io) · endpoint",
      "MiniMax (minimax.io) · authentication",
      "MiniMax (minimax.io) · API key",
    ]);

    const raw = readRawConfig(ctx.paths!.config!);
    expect(raw["providers"]).toEqual({
      minimax: {
        kind: "anthropic",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
        contextWindow: 1048576,
        pricing: { input: 0.3 / 1_000_000, output: 1.2 / 1_000_000 },
        catalogId: "minimax",
        model: "MiniMax-M3",
      },
    });
    expect(raw["activeProvider"]).toBe("minimax");
    expect(ctx.session.model).toBe("MiniMax-M3");
  });

  test("the key reaches the credentials store and nothing else", async () => {
    const ctx = harness(["minimax", "MiniMax-M3", "trust", "api", "sk-super-secret"]);
    await runConnect(ctx);

    expect(readCredential("minimax", ctx.paths!.credentials!)).toBe("sk-super-secret");
    expect(readFileSync(ctx.paths!.config!, "utf8")).not.toContain("sk-super-secret");
    expect(ctx.output()).not.toContain("sk-super-secret");
  });

  test("choosing the environment method stores no secret", async () => {
    const ctx = harness(["minimax", "MiniMax-M2", "trust", "env"]);
    await runConnect(ctx);

    expect(readCredential("minimax", ctx.paths!.credentials!)).toBeUndefined();
    const entry = readRawConfig(ctx.paths!.config!)["providers"] as Record<string, unknown>;
    expect((entry["minimax"] as Record<string, unknown>)["apiKeyEnv"]).toBe("MINIMAX_API_KEY");
  });

  test("an empty key falls back to the environment rather than storing nothing usefully", async () => {
    const ctx = harness(["minimax", "MiniMax-M2", "trust", "api", ""]);
    await runConnect(ctx);
    expect(readCredential("minimax", ctx.paths!.credentials!)).toBeUndefined();
    expect(readRawConfig(ctx.paths!.config!)["activeProvider"]).toBe("minimax");
  });

  test("environment and blank-key registration clear an older stored credential", async () => {
    const env = harness(["minimax", "MiniMax-M2", "trust", "env"]);
    writeCredential("minimax", "sk-old", env.paths!.credentials!);
    await runConnect(env);
    expect(readCredential("minimax", env.paths!.credentials!)).toBeUndefined();

    const blank = harness(["minimax", "MiniMax-M2", "trust", "api", ""]);
    writeCredential("minimax", "sk-old", blank.paths!.credentials!);
    await runConnect(blank);
    expect(readCredential("minimax", blank.paths!.credentials!)).toBeUndefined();
  });

  test("does not persist an endpoint the user rejects", async () => {
    const ctx = harness(["minimax", "MiniMax-M3", "cancel"]);
    await runConnect(ctx);
    expect(readRawConfig(ctx.paths!.config!)).toEqual({});
    expect(ctx.output()).toContain("endpoint was not approved");
  });

  test("picking an undrivable provider explains itself and writes nothing", async () => {
    const ctx = harness(["bedrock"]);
    await runConnect(ctx);
    expect(ctx.output()).toContain("@ai-sdk/amazon-bedrock");
    expect(readRawConfig(ctx.paths!.config!)).toEqual({});
  });

  test("Esc at any step leaves the config untouched", async () => {
    for (const script of [
      [undefined],
      ["minimax", undefined],
      ["minimax", "MiniMax-M3", undefined],
      ["minimax", "MiniMax-M3", "trust", undefined],
      ["minimax", "MiniMax-M3", "trust", "api", undefined],
    ]) {
      const ctx = harness(script);
      await runConnect(ctx);
      expect(readRawConfig(ctx.paths!.config!)).toEqual({});
      expect(ctx.output()).toContain("cancelled");
    }
  });

  test("Other hands off to the typed wizard", async () => {
    const ctx = harness([CUSTOM]);
    await runConnect(ctx);
    expect(ctx.wizard.active).not.toBeNull();
    expect(ctx.output()).toContain("kind?");
  });

  test("without dialogs it falls back to the typed wizard instead of failing", async () => {
    const ctx = harness([]);
    delete ctx.ui;
    await runConnect(ctx);
    expect(ctx.output()).toContain("typed wizard");
    expect(ctx.wizard.active).not.toBeNull();
  });

  test("local Ollama offers what the daemon actually has", async () => {
    const ctx = harness([OLLAMA_LOCAL, "qwen3:8b"], ["qwen3:8b", "minimax-m3:cloud"]);
    await runConnect(ctx);

    expect(ctx.asked).toEqual(["Add provider", "Ollama model"]);
    expect(ctx.output()).not.toContain("no local Ollama");
    expect(readRawConfig(ctx.paths!.config!)["providers"]).toEqual({
      ollama: { kind: "ollama", model: "qwen3:8b" },
    });
  });

  test("with no Ollama running it asks for a model id by hand", async () => {
    const ctx = harness([OLLAMA_LOCAL, "qwen3:8b"], []);
    await runConnect(ctx);
    expect(ctx.output()).toContain("no local Ollama answered");
    expect(readRawConfig(ctx.paths!.config!)["providers"]).toEqual({
      ollama: { kind: "ollama", model: "qwen3:8b" },
    });
  });

  test("a seed-only catalog says so rather than pretending it is complete", async () => {
    const ctx = harness([undefined]);
    ctx.loadCatalog = async () => ({ catalog: CATALOG, source: "seed" });
    await runConnect(ctx);
    expect(ctx.output()).toContain("could not reach models.dev");
  });
});

describe("/models", () => {
  const registered = (ctx: Harness) => {
    ctx.session.config.providers["minimax"] = {
      kind: "anthropic",
      reasoningEffort: false,
      catalogId: "minimax",
      model: "MiniMax-M2",
    };
  };

  test("lists every model of every registered provider as provider/model", () => {
    const config = defaultConfig();
    config.providers["minimax"] = {
      kind: "anthropic",
      reasoningEffort: false,
      catalogId: "minimax",
      model: "MiniMax-M2",
    };
    const items = allModelItems(config, CATALOG);
    expect(items.map((i) => i.value)).toEqual(["minimax/MiniMax-M2", "minimax/MiniMax-M3"]);
    expect(items[1]?.hint).toContain("1049k ctx");
  });

  test("a hand-written entry contributes only the model it names", () => {
    const config = defaultConfig();
    config.providers["local"] = { kind: "ollama", reasoningEffort: false, model: "qwen3:8b" };
    expect(allModelItems(config, CATALOG).map((i) => i.value)).toEqual(["local/qwen3:8b"]);
  });

  test("switching persists the model against its provider", async () => {
    const ctx = harness(["minimax/MiniMax-M3"]);
    registered(ctx);
    // The entry must already exist on disk for the model write to land.
    ctx.session.config.activeProvider = "minimax";
    await runModels(ctx);

    expect(ctx.session.model).toBe("MiniMax-M3");
    expect(ctx.session.config.providers["minimax"]?.model).toBe("MiniMax-M3");
  });

  test("says so when there is nothing registered yet", async () => {
    const ctx = harness([]);
    await runModels(ctx);
    expect(ctx.output()).toContain("/connect adds one");
  });

  test("without dialogs it prints the list instead of opening a picker", async () => {
    const ctx = harness([]);
    registered(ctx);
    delete ctx.ui;
    await runModels(ctx);
    expect(ctx.output()).toContain("minimax/MiniMax-M3");
    expect(ctx.output()).toContain("/model <id>");
  });
});
