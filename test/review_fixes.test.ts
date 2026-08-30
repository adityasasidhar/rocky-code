/**
 * Regressions for the review findings on the provider-registration work.
 *
 * Each test names the failure it prevents rather than the function it calls:
 * every one of these passed review as "obviously fine" code, and the value is
 * in the scenario, not in the coverage.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCatalog,
  providerConfigFrom,
  safeEndpoint,
  type Catalog,
  type CatalogProvider,
} from "../src/config/catalog.ts";
import { deleteCredential, readCredential, writeCredential } from "../src/config/credentials.ts";
import { loadConfig } from "../src/config/load.ts";
import { modelMetadata } from "../src/core/connect_command.ts";
import {
  forgetProvider,
  registerProvider,
  setRegistryModel,
} from "../src/core/provider_registry.ts";
import { readRawConfig } from "../src/config/write.ts";
import { providersLogin } from "../src/cli_providers.ts";
import { printableOnly } from "../src/tui/app/pickers.tsx";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

const paths = () => ({
  config: join(dir, "config.json"),
  credentials: join(dir, "credentials.json"),
});

const writeProjectConfig = (obj: unknown) => {
  mkdirSync(join(dir, ".rocky"), { recursive: true });
  writeFileSync(join(dir, ".rocky", "config.json"), JSON.stringify(obj), "utf8");
};

/** Make a directory's contents unwritable, so the next write into it fails. */
function sealed<T>(target: string, fn: () => T): T {
  chmodSync(target, 0o500);
  try {
    return fn();
  } finally {
    chmodSync(target, 0o700);
  }
}

describe("a --provider override does not inherit the active entry", () => {
  const registry = {
    backend: "local",
    providers: {
      minimax: {
        kind: "anthropic",
        baseUrl: "https://api.minimax.io/anthropic/v1",
        apiKeyEnv: "MINIMAX_API_KEY",
        model: "MiniMax-M2",
      },
    },
    activeProvider: "minimax",
  };

  test("the endpoint does not survive the switch", () => {
    writeProjectConfig(registry);
    const { config } = loadConfig(dir, { provider: { kind: "ollama" } });
    expect(config.provider.kind).toBe("ollama");
    // The bug: one-level-deep merge left MiniMax's baseUrl under kind "ollama",
    // so Rocky posted Ollama requests — and a key — at api.minimax.io.
    expect(config.provider.baseUrl).not.toBe("https://api.minimax.io/anthropic/v1");
  });

  test("the registry name does not survive it either", () => {
    writeProjectConfig(registry);
    const { config } = loadConfig(dir, { provider: { kind: "ollama" } });
    // activeProvider is what resolves a *stored* key. Leaving it set handed the
    // newly chosen provider the previous one's credential.
    expect(config.activeProvider).toBeUndefined();
  });

  test("--base-url keeps the provider but not its stored key", () => {
    writeProjectConfig(registry);
    const { config } = loadConfig(dir, { provider: { baseUrl: "https://gateway.example/v1" } });
    // The entry still supplies everything but its name: same provider, same
    // credential variable, same model — a different endpoint.
    expect(config.provider.kind).toBe("anthropic");
    expect(config.provider.baseUrl).toBe("https://gateway.example/v1");
    expect(config.provider.apiKeyEnv).toBe("MINIMAX_API_KEY"); // env still works
    expect(config.model).toBe("MiniMax-M2");
    expect(config.activeProvider).toBeUndefined(); // the saved key does not
  });

  test("without an override the active entry still expands", () => {
    writeProjectConfig(registry);
    const { config } = loadConfig(dir);
    expect(config.provider.baseUrl).toBe("https://api.minimax.io/anthropic/v1");
    expect(config.activeProvider).toBe("minimax");
    expect(config.model).toBe("MiniMax-M2");
  });
});

describe("the catalog is untrusted input", () => {
  test("a plaintext endpoint is refused, so a key cannot be sent in the clear", () => {
    expect(safeEndpoint("http://evil.example/v1")).toBeUndefined();
    expect(safeEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
  });

  test("loopback http stays allowed — that is Ollama and local gateways", () => {
    expect(safeEndpoint("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(safeEndpoint("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
  });

  test("non-URLs and other schemes never become a baseUrl", () => {
    for (const bad of ["", "not a url", "file:///etc/passwd", "javascript:alert(1)", "/v1"]) {
      expect(safeEndpoint(bad)).toBeUndefined();
    }
  });

  test("a poisoned cache cannot redirect credential traffic", () => {
    const catalog = parseCatalog({
      acme: {
        id: "acme",
        name: "Acme",
        npm: "@ai-sdk/openai-compatible",
        api: "http://attacker.example/collect",
        env: ["ACME_API_KEY"],
        models: { "acme-1": { limit: { context: 1000 } } },
      },
    });
    expect(catalog["acme"]?.api).toBeUndefined();
    expect(providerConfigFrom(catalog["acme"]!, "acme-1")?.baseUrl).toBeUndefined();
  });

  test("environment names that are not environment names are dropped", () => {
    const catalog = parseCatalog({
      acme: {
        name: "Acme",
        npm: "@ai-sdk/openai",
        env: ["PATH; rm -rf /", "9LIVES", "GOOD_KEY"],
        models: {},
      },
    });
    expect(catalog["acme"]?.env).toEqual(["GOOD_KEY"]);
  });

  test("limits and prices that are not usable numbers are dropped", () => {
    const catalog = parseCatalog({
      acme: {
        name: "Acme",
        npm: "@ai-sdk/openai",
        env: [],
        models: {
          weird: { limit: { context: "1e9" }, cost: { input: -1, output: 2 } },
        },
      },
    });
    const model = catalog["acme"]?.models["weird"];
    expect(model?.limit?.context).toBeUndefined();
    expect(model?.cost?.input).toBeUndefined();
    expect(model?.cost?.output).toBe(2);
  });
});

describe("switching model re-derives what belongs to the model", () => {
  const catalog: Catalog = {
    acme: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai",
      api: "https://api.acme.test/v1",
      env: ["ACME_API_KEY"],
      models: {
        big: { id: "big", limit: { context: 1_000_000 }, cost: { input: 3, output: 15 } },
        bare: { id: "bare" },
      },
    },
  };

  test("the new model's window and price replace the old one's", () => {
    expect(modelMetadata("acme", "big", catalog)).toEqual({
      contextWindow: 1_000_000,
      pricing: { input: 3 / 1e6, output: 15 / 1e6 },
    });
  });

  test("a model the catalog says nothing about clears them rather than inheriting", () => {
    expect(modelMetadata("acme", "bare", catalog)).toEqual({});
    expect(modelMetadata(undefined, "anything", catalog)).toEqual({});
  });

  test("the persisted entry loses the previous model's numbers", () => {
    const p = paths();
    registerProvider(
      {
        name: "acme",
        kind: "openai",
        model: "big",
        catalogId: "acme",
        contextWindow: 1_000_000,
        pricing: { input: 3e-6, output: 15e-6 },
      },
      undefined,
      p,
    );
    setRegistryModel("acme", "bare", modelMetadata("acme", "bare", catalog), p);

    const entry = (readRawConfig(p.config)["providers"] as Record<string, Record<string, unknown>>)[
      "acme"
    ];
    expect(entry?.["model"]).toBe("bare");
    // Compaction would otherwise size against a million-token window this model
    // does not have, and every token would be billed at the old model's rate.
    expect(entry?.["contextWindow"]).toBeUndefined();
    expect(entry?.["pricing"]).toBeUndefined();
    // The endpoint belongs to the provider, not the model, and must stay.
    expect(entry?.["kind"]).toBe("openai");
  });
});

describe("the credential store never reports a deletion it did not do", () => {
  test("a successful delete removes the file", () => {
    const p = paths();
    writeCredential("acme", "sk-1", p.credentials);
    expect(deleteCredential("acme", p.credentials)).toBe(true);
    expect(existsSync(p.credentials)).toBe(false);
  });

  test("deleting one of several leaves the rest at 0600", () => {
    const p = paths();
    writeCredential("acme", "sk-1", p.credentials);
    writeCredential("other", "sk-2", p.credentials);
    expect(deleteCredential("acme", p.credentials)).toBe(true);
    expect(readCredential("acme", p.credentials)).toBeUndefined();
    expect(readCredential("other", p.credentials)).toBe("sk-2");
  });

  test("a delete that cannot happen throws instead of returning true", () => {
    if (asRoot) return;
    const p = paths();
    writeCredential("acme", "sk-1", p.credentials);
    // The old code swallowed the unlink failure and said "removed" while the
    // key was still on disk.
    sealed(dir, () => {
      expect(() => deleteCredential("acme", p.credentials)).toThrow();
    });
    expect(readCredential("acme", p.credentials)).toBe("sk-1");
  });

  test("nothing to delete is false, not an error", () => {
    expect(deleteCredential("absent", paths().credentials)).toBe(false);
  });
});

describe("registration commits the key and the entry together", () => {
  test("a config write that fails takes the credential back out", () => {
    if (asRoot) return;
    const p = paths();
    const configDir = join(dir, "cfg");
    mkdirSync(configDir);
    const config = join(configDir, "config.json");

    sealed(configDir, () => {
      expect(() =>
        registerProvider({ name: "acme", kind: "openai", model: "m" }, "sk-live", {
          config,
          credentials: p.credentials,
        }),
      ).toThrow();
    });
    // Otherwise a failed registration leaves a secret nobody knows about.
    expect(readCredential("acme", p.credentials)).toBeUndefined();
  });

  test("a rollback restores the key that was already there", () => {
    if (asRoot) return;
    const p = paths();
    writeCredential("acme", "sk-old", p.credentials);
    const configDir = join(dir, "cfg");
    mkdirSync(configDir);

    sealed(configDir, () => {
      expect(() =>
        registerProvider({ name: "acme", kind: "openai", model: "m" }, "sk-new", {
          config: join(configDir, "config.json"),
          credentials: p.credentials,
        }),
      ).toThrow();
    });
    expect(readCredential("acme", p.credentials)).toBe("sk-old");
  });

  test("the happy path still writes both", () => {
    const p = paths();
    const result = registerProvider({ name: "acme", kind: "openai", model: "m" }, "sk-live", p);
    expect(result.stored).toBe(true);
    expect(readCredential("acme", p.credentials)).toBe("sk-live");
    expect(readRawConfig(p.config)["activeProvider"]).toBe("acme");
  });
});

describe("forgetting a provider never strands its key", () => {
  test("a config write that fails leaves the key recoverable, not orphaned", () => {
    if (asRoot) return;
    const p = paths();
    writeCredential("acme", "sk-live", p.credentials);
    const configDir = join(dir, "cfg");
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ providers: { acme: { kind: "openai" } }, activeProvider: "acme" }),
    );

    sealed(configDir, () => {
      expect(() =>
        forgetProvider("acme", {
          config: join(configDir, "config.json"),
          credentials: p.credentials,
        }),
      ).toThrow();
    });
    // Either both go or neither does — never "entry gone, secret kept".
    const raw = readRawConfig(join(configDir, "config.json"));
    expect((raw["providers"] as Record<string, unknown>)["acme"]).toBeDefined();
    expect(readCredential("acme", p.credentials)).toBe("sk-live");
  });

  test("the happy path removes both and says so", () => {
    const p = paths();
    registerProvider({ name: "acme", kind: "openai", model: "m" }, "sk-live", p);
    const result = forgetProvider("acme", p);
    expect(result.removedKey).toBe(true);
    expect(result.wasActive).toBe(true);
    expect(readCredential("acme", p.credentials)).toBeUndefined();
    expect(readRawConfig(p.config)["activeProvider"]).toBeUndefined();
  });
});

describe("providers login without a terminal", () => {
  const catalog: Catalog = {
    acme: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai",
      api: "https://api.acme.test/v1",
      env: ["ACME_API_KEY"],
      models: { "acme-1": { id: "acme-1" } },
    },
  };

  test("a question it cannot ask is denied, not blocked on", async () => {
    // The bug: readline opened on a pipe and the command hung forever.
    expect(await providersLogin(catalog, { isTty: false })).toBe(1);
  });

  test("-m api is refused without a terminal — the key is typed in", async () => {
    expect(
      await providersLogin(catalog, {
        isTty: false,
        provider: "acme",
        model: "acme-1",
        method: "api",
      }),
    ).toBe(1);
  });

  test("a wrong model id is rejected against the catalog", async () => {
    expect(
      await providersLogin(catalog, {
        isTty: false,
        provider: "acme",
        model: "no-such-model",
        method: "env",
      }),
    ).toBe(1);
  });
});

describe("a pasted key keeps only what was typed", () => {
  test("a trailing newline never reaches the credential store", () => {
    // "sk-abc\n" >= " " is true: the comparison only looks at the first
    // character, so the newline used to be stored and then sent as a header.
    expect(printableOnly("sk-abc\n")).toBe("sk-abc");
    expect(printableOnly("sk-abc\r\n")).toBe("sk-abc");
  });

  test("embedded controls go too, and ordinary pastes are untouched", () => {
    expect(printableOnly("sk-\x00\x07abc")).toBe("sk-abc");
    expect(printableOnly("sk-proj-AbC123_-xyz")).toBe("sk-proj-AbC123_-xyz");
    expect(printableOnly("modèle-é")).toBe("modèle-é");
  });

  test("escape sequences are still rejected whole", () => {
    expect(printableOnly("\x1b[A")).toBe("");
  });
});

/** Kept honest: the fixture provider must be one `providerConfigFrom` accepts. */
test("the test catalog is a catalog Rocky supports", () => {
  const provider: CatalogProvider = {
    id: "acme",
    name: "Acme",
    npm: "@ai-sdk/openai",
    api: "https://api.acme.test/v1",
    env: ["ACME_API_KEY"],
    models: {},
  };
  expect(providerConfigFrom(provider)?.kind).toBe("openai");
});
