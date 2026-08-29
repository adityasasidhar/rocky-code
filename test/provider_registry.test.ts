import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import {
  credentialNames,
  deleteCredential,
  readCredential,
  resolveApiKey,
  writeCredential,
} from "../src/config/credentials.ts";
import {
  advanceWizard,
  describeKey,
  draftToEntry,
  parseProviderCommand,
  providerRows,
  startWizard,
  wizardIsSecret,
  wizardPrompt,
  type Wizard,
  type WizardResult,
} from "../src/config/providers.ts";
import { readRawConfig, updateGlobalConfig } from "../src/config/write.ts";
import { ConfigSchema } from "../src/config/schema.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const writeProjectConfig = (obj: unknown) => {
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "config.json"), JSON.stringify(obj), "utf8");
};

/** Drive the wizard through a scripted set of answers, as a REPL would. */
function run(answers: string[], start: Wizard = startWizard()): WizardResult {
  let wizard = start;
  let result: WizardResult = { kind: "next", wizard };
  for (const answer of answers) {
    result = advanceWizard(wizard, answer);
    if (result.kind === "next" || result.kind === "retry") wizard = result.wizard;
    else return result;
  }
  return result;
}

describe("parseProviderCommand", () => {
  test("bare /provider shows the active provider", () => {
    expect(parseProviderCommand("")).toEqual({ kind: "show" });
    expect(parseProviderCommand("   ")).toEqual({ kind: "show" });
  });

  test("recognizes the subcommands and their opencode-style aliases", () => {
    expect(parseProviderCommand("list")).toEqual({ kind: "list" });
    expect(parseProviderCommand("ls")).toEqual({ kind: "list" });
    expect(parseProviderCommand("login")).toEqual({ kind: "add" });
    expect(parseProviderCommand("add groq")).toEqual({ kind: "add", name: "groq" });
    expect(parseProviderCommand("use groq")).toEqual({ kind: "use", name: "groq" });
    expect(parseProviderCommand("logout groq")).toEqual({ kind: "remove", name: "groq" });
  });

  test("a subcommand missing its name is an error, not a silent no-op", () => {
    expect(parseProviderCommand("use")).toMatchObject({ kind: "error" });
    expect(parseProviderCommand("remove")).toMatchObject({ kind: "error" });
  });

  test("rejects names that could not round-trip through the config", () => {
    const result = parseProviderCommand("use My Provider");
    // Two words: the second is not a name, so this is an argument-count error.
    expect(result.kind).toBe("error");
    expect(parseProviderCommand("use UPPER")).toMatchObject({ kind: "error" });
    expect(parseProviderCommand("add so/slash")).toMatchObject({ kind: "error" });
  });

  test("an unknown subcommand names the ones that exist", () => {
    const result = parseProviderCommand("frobnicate");
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("list, add, use, or remove");
  });
});

describe("registration wizard", () => {
  test("registers an openai-compatible provider with a pasted key", () => {
    const result = run([
      "openai-compatible",
      "groq",
      "https://api.groq.com/openai/v1",
      "llama-3.3-70b",
      "sk-secret-value",
    ]);

    expect(result).toEqual({
      kind: "done",
      draft: {
        name: "groq",
        kind: "openai-compatible",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b",
      },
      secret: "sk-secret-value",
    });
  });

  test("accepts the kind by number, as the prompt offers", () => {
    const result = run(["5", "local", "", "qwen3:8b"]);
    expect(result).toMatchObject({ kind: "done", draft: { kind: "ollama" } });
  });

  test("ollama finishes at the model — it is never asked for a key", () => {
    const result = run(["ollama", "local", "", "qwen3:8b"]);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.secret).toBeUndefined();
      // An accepted default endpoint is deliberately not written down.
      expect(result.draft.baseUrl).toBeUndefined();
    }
  });

  test("anthropic is never asked for a base URL", () => {
    let wizard = startWizard();
    const afterKind = advanceWizard(wizard, "anthropic");
    expect(afterKind).toMatchObject({ kind: "next", wizard: { step: "name" } });
    if (afterKind.kind !== "next") throw new Error("unreachable");
    const afterName = advanceWizard(afterKind.wizard, "work");
    expect(afterName).toMatchObject({ kind: "next", wizard: { step: "model" } });
  });

  test("a name given as `/provider add groq` is not asked for twice", () => {
    const result = advanceWizard(startWizard("groq"), "anthropic");
    expect(result).toMatchObject({ kind: "next", wizard: { step: "model" } });
  });

  test("env:NAME records the variable and stores no secret", () => {
    const result = run([
      "openai-compatible",
      "groq",
      "https://api.groq.com/openai/v1",
      "llama-3.3-70b",
      "env:GROQ_API_KEY",
    ]);
    expect(result).toMatchObject({
      kind: "done",
      draft: { apiKeyEnv: "GROQ_API_KEY" },
    });
    if (result.kind === "done") expect(result.secret).toBeUndefined();
  });

  test("an empty key falls back to the environment without storing anything", () => {
    const result = run(["openai", "work", "", "gpt-5", ""]);
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.secret).toBeUndefined();
      expect(result.draft.apiKeyEnv).toBeUndefined();
    }
  });

  test("bad answers re-ask the same question instead of advancing", () => {
    const badKind = advanceWizard(startWizard(), "gpt");
    expect(badKind).toMatchObject({ kind: "retry", wizard: { step: "kind" } });

    const atUrl = run(["openai-compatible", "groq"]);
    if (atUrl.kind !== "next") throw new Error("unreachable");
    expect(advanceWizard(atUrl.wizard, "not a url")).toMatchObject({
      kind: "retry",
      wizard: { step: "baseUrl" },
    });
    // openai-compatible has no default endpoint, so Enter cannot skip it.
    expect(advanceWizard(atUrl.wizard, "")).toMatchObject({ kind: "retry" });
  });

  test("a lowercase env: answer is corrected rather than stored as a key", () => {
    const atKey = run(["openai", "work", "", "gpt-5"]);
    if (atKey.kind !== "next") throw new Error("unreachable");
    const result = advanceWizard(atKey.wizard, "env:groq_key");
    expect(result).toMatchObject({ kind: "retry" });
    if (result.kind === "retry") expect(result.message).toContain("UPPER_SNAKE_CASE");
  });

  test("/cancel abandons the registration at any step", () => {
    expect(advanceWizard(startWizard(), "/cancel")).toEqual({ kind: "cancelled" });
    const midway = run(["openai", "work"]);
    if (midway.kind !== "next") throw new Error("unreachable");
    expect(advanceWizard(midway.wizard, "/cancel")).toEqual({ kind: "cancelled" });
  });

  test("only the key step is marked secret", () => {
    const atKey = run(["openai", "work", "", "gpt-5"]);
    if (atKey.kind !== "next") throw new Error("unreachable");
    expect(wizardIsSecret(atKey.wizard)).toBe(true);
    expect(wizardIsSecret(startWizard())).toBe(false);
    expect(wizardPrompt(atKey.wizard)).toContain("OPENAI_API_KEY");
  });

  test("the entry a draft becomes carries no secret", () => {
    const entry = draftToEntry({
      name: "groq",
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
    });
    expect(entry).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b",
    });
    expect(JSON.stringify(entry)).not.toContain("sk-");
  });
});

describe("credentials store", () => {
  const path = () => join(dir, "credentials.json");

  test("round-trips a key and keeps the file private", () => {
    writeCredential("groq", "sk-secret", path());
    expect(readCredential("groq", path())).toBe("sk-secret");
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  test("tightens the mode on a file that already existed world-readable", () => {
    writeFileSync(path(), "{}\n", { mode: 0o644 });
    writeCredential("groq", "sk-secret", path());
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  test("keeps other providers when one is removed", () => {
    writeCredential("groq", "a", path());
    writeCredential("work", "b", path());
    expect(deleteCredential("groq", path())).toBe(true);
    expect(credentialNames(path())).toEqual(["work"]);
    expect(deleteCredential("groq", path())).toBe(false);
  });

  test("a corrupt store reads as empty rather than killing the session", () => {
    writeFileSync(path(), "{ not json", "utf8");
    expect(credentialNames(path())).toEqual([]);
  });

  test("the environment wins over a stored key", () => {
    writeCredential("work", "stored-key", path());
    const resolved = resolveApiKey(
      { kind: "openai", apiKeyEnv: undefined },
      { name: "work", env: { OPENAI_API_KEY: "env-key" }, path: path() },
    );
    expect(resolved).toEqual({ key: "env-key", source: "env", envVar: "OPENAI_API_KEY" });
  });

  test("falls back to the stored key when the variable is unset", () => {
    writeCredential("work", "stored-key", path());
    const resolved = resolveApiKey(
      { kind: "openai", apiKeyEnv: undefined },
      { name: "work", env: {}, path: path() },
    );
    expect(resolved).toEqual({ key: "stored-key", source: "stored", envVar: "OPENAI_API_KEY" });
  });

  test("reports no key rather than guessing one", () => {
    const resolved = resolveApiKey(
      { kind: "minimax", apiKeyEnv: undefined },
      { name: "absent", env: {}, path: path() },
    );
    expect(resolved.source).toBe("none");
    expect(resolved.key).toBeUndefined();
    expect(resolved.envVar).toBe("MINIMAX_API_KEY");
  });
});

describe("config writer", () => {
  const path = () => join(dir, "config.json");

  test("creates the file and its directory", () => {
    updateGlobalConfig((raw) => ({ ...raw, activeProvider: "groq" }), join(dir, "nested", "c.json"));
    expect(readRawConfig(join(dir, "nested", "c.json"))["activeProvider"]).toBe("groq");
  });

  test("preserves keys it does not understand", () => {
    writeFileSync(path(), JSON.stringify({ theme: "dracula", futureKey: [1, 2] }), "utf8");
    updateGlobalConfig((raw) => ({ ...raw, activeProvider: "groq" }), path());
    const raw = readRawConfig(path());
    expect(raw["theme"]).toBe("dracula");
    expect(raw["futureKey"]).toEqual([1, 2]);
  });

  test("refuses to write a literal secret into a shareable file", () => {
    expect(() =>
      updateGlobalConfig(
        (raw) => ({ ...raw, providers: { groq: { apiKey: "sk-oops" } } }),
        path(),
      ),
    ).toThrow(/refusing to write a literal secret/);
  });

  test("an env var *name* is not a secret", () => {
    updateGlobalConfig(
      (raw) => ({ ...raw, providers: { groq: { apiKeyEnv: "GROQ_API_KEY" } } }),
      path(),
    );
    expect(readRawConfig(path())["providers"]).toEqual({ groq: { apiKeyEnv: "GROQ_API_KEY" } });
  });
});

describe("activeProvider resolution", () => {
  test("the active entry supplies provider and model", () => {
    writeProjectConfig({
      backend: "local",
      providers: {
        groq: {
          kind: "openai-compatible",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b",
        },
      },
      activeProvider: "groq",
    });
    const { config } = loadConfig(dir);
    expect(config.provider.kind).toBe("openai-compatible");
    expect(config.provider.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(config.model).toBe("llama-3.3-70b");
  });

  test("activating replaces the provider block rather than merging into it", () => {
    // The bug this guards: a leftover baseUrl from the previous provider would
    // point the new one at the wrong server.
    writeProjectConfig({
      provider: { kind: "openai-compatible", baseUrl: "http://old.example/v1", think: true },
      providers: { work: { kind: "anthropic", model: "claude-sonnet-5" } },
      activeProvider: "work",
    });
    const { config } = loadConfig(dir);
    expect(config.provider.kind).toBe("anthropic");
    expect(config.provider.baseUrl).toBeUndefined();
    expect(config.provider.think).toBeUndefined();
  });

  test("a CLI flag still beats the persisted active provider", () => {
    writeProjectConfig({
      providers: { groq: { kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" } },
      activeProvider: "groq",
    });
    const { config } = loadConfig(dir, { provider: { kind: "ollama" }, model: "qwen3:8b" });
    expect(config.provider.kind).toBe("ollama");
    expect(config.model).toBe("qwen3:8b");
  });

  test("an activeProvider naming nothing is a config error, not a silent default", () => {
    writeProjectConfig({ providers: { groq: { kind: "openai" } }, activeProvider: "typo" });
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/not in providers \(have: groq\)/);
  });

  test("the registry alone changes nothing until one is activated", () => {
    writeProjectConfig({
      providers: { groq: { kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" } },
    });
    const { config } = loadConfig(dir);
    expect(config.provider.kind).toBe("anthropic");
    expect(Object.keys(config.providers)).toEqual(["groq"]);
  });
});

describe("provider listing", () => {
  const config = ConfigSchema.parse({
    model: "fallback-model",
    providers: {
      groq: {
        kind: "openai-compatible",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b",
      },
      local: { kind: "ollama" },
      work: { kind: "anthropic", model: "claude-sonnet-5" },
    },
    activeProvider: "groq",
  });

  test("rows are sorted, marked active, and filled in from the kind's defaults", () => {
    const rows = providerRows(config, () => "stored");
    expect(rows.map((r) => r.name)).toEqual(["groq", "local", "work"]);
    expect(rows[0]?.active).toBe(true);
    expect(rows[1]?.model).toBe("fallback-model");
    expect(rows[1]?.endpoint).toBe("http://127.0.0.1:11434");
    expect(rows[2]?.endpoint).toBe("(sdk default)");
  });

  test("describes where each key comes from without ever holding one", () => {
    const rows = providerRows(config, (name) => (name === "groq" ? "stored" : "none"));
    expect(describeKey(rows[0]!)).toBe("key stored");
    expect(describeKey(rows[1]!)).toBe("no auth");
    expect(describeKey(rows[2]!)).toBe("no key (set ANTHROPIC_API_KEY)");
  });
});
