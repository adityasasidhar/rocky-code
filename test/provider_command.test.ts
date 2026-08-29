import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config/schema.ts";
import { readCredential } from "../src/config/credentials.ts";
import { readRawConfig } from "../src/config/write.ts";
import { Session } from "../src/core/session.ts";
import {
  awaitingProviderAnswer,
  awaitingSecret,
  runProviderCommand,
  runProviderWizardLine,
  type ProviderCommandCtx,
} from "../src/core/provider_command.ts";
import { forgetProvider, registerProvider } from "../src/core/provider_registry.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

type Harness = ProviderCommandCtx & {
  lines: string[];
  output: () => string;
  backend: { kind: "trueforge" | "local" };
  switched: () => boolean;
};

function harness(): Harness {
  const session = new Session({
    cwd: dir,
    config: defaultConfig(),
    provider: new MockProvider([]),
    projectDir: dir,
  });
  const lines: string[] = [];
  const backend: { kind: "trueforge" | "local" } = { kind: "trueforge" };
  let switched = false;

  return {
    session,
    backendKind: () => backend.kind,
    switchToLocal: () => {
      switched = true;
      backend.kind = "local";
    },
    out: (line) => lines.push(line),
    wizard: { active: null },
    paths: {
      config: join(dir, "config.json"),
      credentials: join(dir, "credentials.json"),
    },
    lines,
    output: () => lines.join("\n"),
    backend,
    switched: () => switched,
  };
}

/** Type every answer a user would, one submitted line at a time. */
async function register(ctx: ProviderCommandCtx, answers: string[]): Promise<void> {
  await runProviderCommand(" add", ctx);
  for (const answer of answers) {
    expect(awaitingProviderAnswer(ctx)).toBe(true);
    await runProviderWizardLine(answer, ctx);
  }
}

describe("/provider add", () => {
  test("registers, persists, stores the key, and activates in one pass", async () => {
    const ctx = harness();
    await register(ctx, [
      "ollama",
      "local",
      // A closed port: prepare()'s startup probe must not reach a real Ollama.
      "http://127.0.0.1:1",
      "qwen3:8b",
    ]);

    expect(awaitingProviderAnswer(ctx)).toBe(false);
    const raw = readRawConfig(ctx.paths!.config!);
    expect(raw["providers"]).toEqual({
      local: { kind: "ollama", baseUrl: "http://127.0.0.1:1", model: "qwen3:8b" },
    });
    expect(raw["activeProvider"]).toBe("local");

    // The live session followed the registration, without being rebuilt.
    expect(ctx.session.model).toBe("qwen3:8b");
    expect(ctx.session.config.activeProvider).toBe("local");
    expect(ctx.session.config.provider.kind).toBe("ollama");
    expect(ctx.output()).toContain("registered local");
  });

  test("a pasted key goes to the credentials file, never to the config", async () => {
    const ctx = harness();
    await register(ctx, [
      "openai-compatible",
      "groq",
      "https://api.groq.com/openai/v1",
      "llama-3.3-70b",
      "sk-super-secret",
    ]);

    expect(readCredential("groq", ctx.paths!.credentials!)).toBe("sk-super-secret");
    expect(readFileSync(ctx.paths!.config!, "utf8")).not.toContain("sk-super-secret");
    expect(ctx.output()).not.toContain("sk-super-secret");
    expect(ctx.output()).toContain("key stored");
  });

  test("the key step is the only one flagged secret", async () => {
    const ctx = harness();
    await runProviderCommand(" add", ctx);
    expect(awaitingSecret(ctx)).toBe(false);
    for (const answer of ["openai", "work", "", "gpt-5"]) {
      await runProviderWizardLine(answer, ctx);
    }
    expect(awaitingSecret(ctx)).toBe(true);
  });

  test("activating under TrueForge moves the session onto the local loop", async () => {
    const ctx = harness();
    await register(ctx, ["ollama", "local", "http://127.0.0.1:1", "qwen3:8b"]);
    expect(ctx.switched()).toBe(true);
    expect(ctx.output()).toContain("backend → local");
  });

  test("a bad answer re-asks without advancing or writing anything", async () => {
    const ctx = harness();
    await runProviderCommand(" add", ctx);
    await runProviderWizardLine("gpt-4-turbo", ctx);
    expect(awaitingProviderAnswer(ctx)).toBe(true);
    expect(ctx.output()).toContain("pick one of");
    expect(readRawConfig(ctx.paths!.config!)).toEqual({});
  });

  test("/cancel writes nothing", async () => {
    const ctx = harness();
    await runProviderCommand(" add", ctx);
    await runProviderWizardLine("openai", ctx);
    await runProviderWizardLine("/cancel", ctx);
    expect(awaitingProviderAnswer(ctx)).toBe(false);
    expect(readRawConfig(ctx.paths!.config!)).toEqual({});
    expect(ctx.output()).toContain("cancelled");
  });
});

describe("/provider use", () => {
  test("switches the live session and persists the choice", async () => {
    const ctx = harness();
    registerProvider(
      { name: "local", kind: "ollama", baseUrl: "http://127.0.0.1:1", model: "qwen3:8b" },
      undefined,
      ctx.paths!,
    );
    ctx.session.config.providers["local"] = {
      kind: "ollama",
      baseUrl: "http://127.0.0.1:1",
      reasoningEffort: false,
      model: "qwen3:8b",
    };

    await runProviderCommand(" use local", ctx);
    expect(ctx.session.model).toBe("qwen3:8b");
    expect(ctx.session.provider.name).toBe("ollama");
    expect(readRawConfig(ctx.paths!.config!)["activeProvider"]).toBe("local");
  });

  test("an unregistered name lists what is registered instead of failing silently", async () => {
    const ctx = harness();
    ctx.session.config.providers["local"] = { kind: "ollama", reasoningEffort: false };
    await runProviderCommand(" use nope", ctx);
    expect(ctx.output()).toContain("no provider named nope");
    expect(ctx.output()).toContain("registered: local");
  });

  test("warns when a provider that needs a key has none", async () => {
    const ctx = harness();
    ctx.session.config.providers["work"] = {
      kind: "openai-compatible",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "DEFINITELY_UNSET_KEY_VAR",
      reasoningEffort: false,
      model: "gpt-5",
    };
    await runProviderCommand(" use work", ctx);
    expect(ctx.output()).toContain("no key found");
    expect(ctx.output()).toContain("DEFINITELY_UNSET_KEY_VAR");
  });
});

describe("/provider list and show", () => {
  test("lists registered providers, marking the active one", async () => {
    const ctx = harness();
    ctx.session.config.providers["local"] = {
      kind: "ollama",
      reasoningEffort: false,
      model: "qwen3:8b",
    };
    ctx.session.config.providers["work"] = {
      kind: "anthropic",
      reasoningEffort: false,
      model: "claude-sonnet-5",
    };
    ctx.session.config.activeProvider = "work";

    await runProviderCommand(" list", ctx);
    const out = ctx.output();
    expect(out).toContain("* work");
    expect(out).toContain("  local");
    expect(out).toContain("no auth");
  });

  test("an empty registry still shows the provider actually in use", async () => {
    // The contradiction this guards: "no providers registered" printed while a
    // provider from the config file is plainly answering every turn.
    const ctx = harness();
    await runProviderCommand(" list", ctx);
    const out = ctx.output();
    expect(out).toContain("* (config file)");
    expect(out).toContain("anthropic");
    expect(out).toContain("/provider add registers one");
  });

  test("bare /provider names the config-file provider instead of (unnamed)", async () => {
    const ctx = harness();
    await runProviderCommand("", ctx);
    const out = ctx.output();
    expect(out).toContain("(config file)");
    expect(out).not.toContain("(unnamed)");
    expect(out).toContain("not in the registry");
  });

  test("a registered active provider is named, with no config-file row", async () => {
    const ctx = harness();
    ctx.session.config.providers["work"] = {
      kind: "anthropic",
      reasoningEffort: false,
      model: "claude-sonnet-5",
    };
    ctx.session.config.activeProvider = "work";
    await runProviderCommand(" list", ctx);
    expect(ctx.output()).toContain("* work");
    expect(ctx.output()).not.toContain("(config file)");
  });

  test("bare /provider reports the endpoint, the auth source, and the backend", async () => {
    const ctx = harness();
    await runProviderCommand("", ctx);
    const out = ctx.output();
    expect(out).toContain("endpoint");
    expect(out).toContain("auth");
    expect(out).toContain("backend   trueforge");
  });

  test("an unknown subcommand shows the usage rather than guessing", async () => {
    const ctx = harness();
    await runProviderCommand(" frobnicate", ctx);
    expect(ctx.output()).toContain("/provider add");
  });
});

describe("/provider remove", () => {
  test("removes the entry, the stored key, and the active pointer together", async () => {
    const ctx = harness();
    registerProvider(
      { name: "groq", kind: "openai-compatible", baseUrl: "https://x.test/v1", model: "m" },
      "sk-secret",
      ctx.paths!,
    );
    ctx.session.config.providers["groq"] = {
      kind: "openai-compatible",
      reasoningEffort: false,
      model: "m",
    };
    ctx.session.config.activeProvider = "groq";

    await runProviderCommand(" remove groq", ctx);
    const raw = readRawConfig(ctx.paths!.config!);
    expect(raw["providers"]).toEqual({});
    expect(raw["activeProvider"]).toBeUndefined();
    expect(readCredential("groq", ctx.paths!.credentials!)).toBeUndefined();
    expect(ctx.session.config.providers["groq"]).toBeUndefined();
  });

  test("removing an unknown provider changes nothing", async () => {
    const ctx = harness();
    await runProviderCommand(" remove ghost", ctx);
    expect(ctx.output()).toContain("no provider named ghost");
  });
});

describe("registry writes", () => {
  test("registering twice updates the entry in place", () => {
    const paths = { config: join(dir, "c.json"), credentials: join(dir, "cred.json") };
    registerProvider({ name: "groq", kind: "openai", model: "a" }, undefined, paths);
    registerProvider({ name: "groq", kind: "openai", model: "b" }, undefined, paths);
    expect(readRawConfig(paths.config)["providers"]).toEqual({
      groq: { kind: "openai", model: "b" },
    });
  });

  test("forgetting leaves unrelated config untouched", () => {
    const paths = { config: join(dir, "c.json"), credentials: join(dir, "cred.json") };
    writeFileSync(paths.config, JSON.stringify({ theme: "dracula" }), "utf8");
    registerProvider({ name: "groq", kind: "openai", model: "a" }, "sk-x", paths);
    const result = forgetProvider("groq", paths);

    expect(result.removedKey).toBe(true);
    expect(result.wasActive).toBe(true);
    expect(readRawConfig(paths.config)["theme"]).toBe("dracula");
  });
});
