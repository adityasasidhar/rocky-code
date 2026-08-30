/**
 * `rocky providers …` and `rocky models …` — the standalone half of provider
 * management, mirroring `opencode providers` and `opencode models`.
 *
 * These run without a session, so they have no dialog layer. `providers list`,
 * `providers logout`, and `models` need none. `providers login` reads from
 * stdin instead: a filter, then a number. The searchable picker lives in the
 * session, at `/connect` — this is the scriptable path
 * (`--provider`/`--model`/`-m env` skip every question, and so run unattended).
 */
import { createInterface } from "node:readline/promises";
import {
  catalogModels,
  catalogProviders,
  isSupported,
  loadCatalog,
  providerConfigFrom,
  unsupportedReason,
  type Catalog,
  type CatalogProvider,
} from "./config/catalog.ts";
import { credentialNames } from "./config/credentials.ts";
import type { Config } from "./config/schema.ts";
import { forgetProvider, registerProvider } from "./core/provider_registry.ts";
import { bold, cyan, dim, gray, green, red, yellow } from "./tui/ansi.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;

/** Display name for a registry key, borrowed from the catalog when it has one. */
const displayName = (id: string, catalog: Catalog): string => catalog[id]?.name ?? id;

/**
 * opencode's two panels: what has a stored credential, and what the environment
 * would supply on its own. Both matter, and conflating them hides the case
 * where a variable is set but nothing is registered.
 */
export function providersList(
  config: Config,
  catalog: Catalog,
  opts: { env?: Record<string, string | undefined>; credentialsPath?: string } = {},
): string {
  const env = opts.env ?? process.env;
  const lines: string[] = [];
  const stored = opts.credentialsPath ? credentialNames(opts.credentialsPath) : credentialNames();

  lines.push(bold("Credentials") + dim("  ~/.rocky/credentials.json"));
  const registered = Object.keys(config.providers).sort();
  if (registered.length === 0 && stored.length === 0) {
    lines.push(dim("  nothing registered — rocky providers login, or /connect in a session"));
  }
  for (const id of registered) {
    const entry = config.providers[id]!;
    const active = config.activeProvider === id;
    const how = stored.includes(id) ? "api" : (entry.apiKeyEnv ?? "env");
    lines.push(
      `  ${active ? green("●") : gray("●")} ${displayName(id, catalog)} ${dim(how)}` +
        (entry.model ? dim(` · ${entry.model}`) : ""),
    );
  }
  // A key stored for a provider no longer in the registry is worth surfacing:
  // it is a credential nobody would otherwise remember having.
  for (const id of stored.filter((name) => !registered.includes(name))) {
    lines.push(`  ${yellow("●")} ${displayName(id, catalog)} ${dim("api · not registered")}`);
  }
  lines.push(dim(`  ${registered.length + stored.filter((n) => !registered.includes(n)).length} credentials`));

  lines.push("", bold("Environment"));
  const fromEnv = catalogProviders(catalog).filter((provider) =>
    provider.env.some((name) => env[name]),
  );
  if (fromEnv.length === 0) lines.push(dim("  no provider variables set in this shell"));
  for (const provider of fromEnv) {
    const which = provider.env.find((name) => env[name])!;
    // A variable being set does not mean Rocky can use it: 26 catalog providers
    // need SDKs it has no equivalent for. Saying so here is the difference
    // between a useful panel and a misleading one.
    lines.push(
      `  ${isSupported(provider) ? green("●") : gray("○")} ${provider.name} ${dim(which)}` +
        (isSupported(provider) ? "" : dim(`  (needs ${provider.npm ?? "an unsupported SDK"})`)),
    );
  }
  lines.push(dim(`  ${fromEnv.length} environment variable${fromEnv.length === 1 ? "" : "s"}`));

  return lines.join("\n");
}

/**
 * Which catalog providers this machine can actually reach: registered, or with
 * a credential variable already exported. opencode scopes `models` the same
 * way — listing all 7,000 catalog models would answer a question nobody asked.
 */
export function configuredProviders(
  config: Config,
  catalog: Catalog,
  env: Record<string, string | undefined> = process.env,
): CatalogProvider[] {
  return catalogProviders(catalog).filter((provider) => {
    if (!isSupported(provider)) return false;
    const registered = Object.values(config.providers).some(
      (entry) => entry.catalogId === provider.id,
    );
    return registered || provider.env.some((name) => env[name]);
  });
}

export class ProviderNotFound extends Error {
  constructor(readonly id: string) {
    super(`Provider not found: ${id}`);
    this.name = "ProviderNotFound";
  }
}

/** `rocky models [provider]`, in opencode's `provider/model` form. */
export function modelsList(
  config: Config,
  catalog: Catalog,
  filter?: string,
  verbose = false,
  env: Record<string, string | undefined> = process.env,
): string {
  const available = configuredProviders(config, catalog, env);
  const providers = filter ? available.filter((p) => p.id === filter) : available;
  if (filter && providers.length === 0) throw new ProviderNotFound(filter);
  if (providers.length === 0) {
    return "no providers configured — rocky providers login, or /connect in a session";
  }

  const lines: string[] = [];
  for (const provider of providers) {
    for (const model of catalogModels(provider)) {
      if (!verbose) {
        lines.push(`${provider.id}/${model.id}`);
        continue;
      }
      const context = model.limit?.context;
      const input = model.cost?.input;
      const output = model.cost?.output;
      const meta = [
        context ? `${context} ctx` : undefined,
        input !== undefined && output !== undefined
          ? `$${input}/$${output} per Mtok`
          : undefined,
        model.reasoning ? "reasoning" : undefined,
        model.tool_call ? "tools" : undefined,
      ].filter(Boolean);
      lines.push(`${provider.id}/${model.id}${meta.length ? dim(`  ${meta.join(" · ")}`) : ""}`);
    }
  }
  return lines.join("\n");
}

type Ask = (question: string) => Promise<string>;

/** Number-picked list: the scriptable stand-in for the session's picker. */
async function choose<T>(
  ask: Ask,
  label: string,
  rows: { value: T; label: string; hint?: string; disabled?: boolean }[],
): Promise<T | undefined> {
  const filter = (await ask(`${label} (type to filter, blank for all): `)).trim().toLowerCase();
  const shown = rows.filter((row) => row.label.toLowerCase().includes(filter));
  if (shown.length === 0) {
    console.log(yellow("nothing matched"));
    return undefined;
  }
  shown.slice(0, 40).forEach((row, index) => {
    console.log(
      `  ${cyan(String(index + 1).padStart(3))}  ${row.label}` +
        (row.hint ? dim(` · ${row.hint}`) : ""),
    );
  });
  if (shown.length > 40) console.log(dim(`  … ${shown.length - 40} more; filter further`));

  const answer = (await ask("pick a number: ")).trim();
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > Math.min(shown.length, 40)) {
    console.log(yellow("cancelled"));
    return undefined;
  }
  const picked = shown[index - 1]!;
  if (picked.disabled) {
    console.log(yellow(picked.hint ?? "not available"));
    return undefined;
  }
  return picked.value;
}

export type LoginOptions = {
  /** `--provider`: skip provider selection. */
  provider?: string | undefined;
  /** `--model`: skip model selection. */
  model?: string | undefined;
  /** `-m`: `api` or `env`, skipping method selection. */
  method?: string | undefined;
  /** Injected for tests; defaults to whether stdin is a terminal. */
  isTty?: boolean | undefined;
  /** Explicitly accept the catalog endpoint in a non-interactive invocation. */
  trustCatalogEndpoint?: boolean | undefined;
};

/** Thrown at the moment a question is unavoidable and there is nobody to ask. */
class NonInteractive extends Error {
  constructor(readonly question: string) {
    super(question);
    this.name = "NonInteractive";
  }
}

/**
 * Read an API key without ever writing it to terminal scrollback. Readline
 * cannot suppress echo, so this small raw-mode reader owns the terminal only
 * for the secret itself and restores its state on every exit path.
 */
async function askSecret(question: string): Promise<string | undefined> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new NonInteractive(question.trim());
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasPaused = input.isPaused();
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
      if (!wasRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
    };
    const finish = (result: string | undefined) => {
      cleanup();
      output.write("\n");
      resolve(result);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string | Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003" || char === "\u0004" || char === "\u001b") return finish(undefined);
        if (char === "\b" || char === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        // Printable Unicode only: pastes with embedded controls never become
        // a malformed authorization header or a persisted credential.
        const code = char.codePointAt(0)!;
        if (code >= 0x20 && (code < 0x7f || code > 0x9f)) {
          value += char;
          output.write("•");
        }
      }
    };

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.once("error", onError);
  });
}

/**
 * The model an unattended run named, checked against the catalog before it is
 * persisted. A provider that lists no models takes any id — that is the same
 * latitude the interactive path gives, and the catalog is not exhaustive.
 */
function resolveModel(provider: CatalogProvider, model: string): string | undefined {
  const models = catalogModels(provider);
  if (models.length === 0) return model;
  return models.some((m) => m.id === model) ? model : undefined;
}

export async function providersLogin(catalog: Catalog, opts: LoginOptions): Promise<number> {
  const interactive = opts.isTty ?? Boolean(process.stdin.isTTY);

  // Built on demand. A fully specified login must not touch stdin at all —
  // opening a readline on a pipe is what made this command hang in CI.
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask: Ask = (question) => {
    if (!interactive) throw new NonInteractive(question.trim());
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(question);
  };

  try {
    const id =
      opts.provider ??
      (await choose(
        ask,
        "provider",
        catalogProviders(catalog).map((provider) => ({
          value: provider.id,
          label: provider.name,
          hint: isSupported(provider)
            ? `${Object.keys(provider.models).length} models`
            : "unsupported",
          disabled: !isSupported(provider),
        })),
      ));
    if (!id) return EXIT_ERROR;

    const provider = catalog[id];
    if (!provider) {
      console.error(red(`no provider "${id}" in the catalog`));
      return EXIT_ERROR;
    }
    if (!providerConfigFrom(provider)) {
      console.error(red(unsupportedReason(provider)));
      return EXIT_ERROR;
    }

    const model = opts.model
      ? resolveModel(provider, opts.model)
      : await chooseModel(ask, provider);
    if (!model) {
      if (opts.model) {
        console.error(red(`${provider.name} has no model "${opts.model}" in the catalog`));
        console.error(dim(`  rocky models ${provider.id}  lists them`));
      }
      return EXIT_ERROR;
    }

    const config = providerConfigFrom(provider, model)!;
    const method = opts.method ?? (await chooseMethod(ask, provider));
    if (method !== "api" && method !== "env") {
      console.error(red(`unknown method "${method}" — use api or env`));
      return EXIT_ERROR;
    }

    const endpoint = providerConfigFrom(provider)?.baseUrl;
    if (endpoint && !opts.trustCatalogEndpoint) {
      const origin = new URL(endpoint).origin;
      const confirmed = (
        await ask(`Catalog endpoint ${origin}; type trust to allow credentials there: `)
      )
        .trim()
        .toLowerCase();
      if (confirmed !== "trust") {
        console.error(red("catalog endpoint was not approved"));
        return EXIT_ERROR;
      }
    }

    let secret: string | undefined;
    if (method === "api") {
      // Close the ordinary readline interface before temporarily taking raw
      // ownership of stdin. The key itself is rendered as bullets only.
      rl?.close();
      rl = undefined;
      const where = endpoint ? ` → ${new URL(endpoint).host}` : "";
      const typed = await askSecret(
        `API key for ${provider.name}${where} (blank to use the environment): `,
      );
      if (typed === undefined) return EXIT_ERROR;
      secret = typed === "" ? undefined : typed;
    }

    const saved = registerProvider(
      {
        name: provider.id,
        kind: config.kind,
        model,
        catalogId: provider.id,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
        ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
        ...(config.pricing === undefined ? {} : { pricing: config.pricing }),
      },
      secret,
      secret === undefined ? { clearStoredCredential: true } : undefined,
    );
    console.log(
      `${green("✓")} registered ${provider.id} · ${config.kind} · ${model}\n` +
        dim(`  saved to ${saved.configPath}`) +
        (saved.stored ? dim("\n  key stored 0600 in ~/.rocky/credentials.json") : ""),
    );
    return EXIT_OK;
  } catch (e) {
    if (e instanceof NonInteractive) {
      console.error(red(`rocky providers login needs a terminal to ask: ${e.question}`));
      console.error(
        dim(
          "  stdin is not a TTY. Run it from a terminal, or pass --provider, --model\n" +
            "  and -m env --trust-catalog-endpoint to register without being asked anything.\n" +
            "  -m api cannot run unattended: the key itself is typed in.",
        ),
      );
      return EXIT_ERROR;
    }
    throw e;
  } finally {
    rl?.close();
  }
}

async function chooseModel(ask: Ask, provider: CatalogProvider): Promise<string | undefined> {
  const models = catalogModels(provider);
  if (models.length === 0) {
    const typed = (await ask(`model id for ${provider.name}: `)).trim();
    return typed === "" ? undefined : typed;
  }
  return choose(
    ask,
    "model",
    models.map((model) => ({
      value: model.id,
      label: model.id,
      ...(model.limit?.context ? { hint: `${model.limit.context} ctx` } : {}),
    })),
  );
}

async function chooseMethod(ask: Ask, provider: CatalogProvider): Promise<string | undefined> {
  const envVar = provider.env[0];
  if (!envVar) return "api";
  const picked = await choose(ask, "method", [
    { value: "api", label: "API key", hint: "stored 0600" },
    { value: "env", label: `Environment variable (${envVar})`, hint: "read at run time" },
  ]);
  return picked;
}

export function providersLogout(name: string | undefined, config: Config): number {
  if (!name) {
    console.error(red("rocky providers logout needs a provider name"));
    return EXIT_ERROR;
  }
  if (!config.providers[name] && !credentialNames().includes(name)) {
    console.error(red(`nothing registered as "${name}"`));
    return EXIT_ERROR;
  }
  const result = forgetProvider(name);
  console.log(
    `${green("✓")} removed ${name}${result.removedKey ? " and its stored key" : ""}\n` +
      dim(`  ${result.configPath}`),
  );
  return EXIT_OK;
}

/** Shared entry point for both subcommands, called from cli.ts. */
export async function runProvidersSubcommand(
  argv: string[],
  config: Config,
  opts: { refresh?: boolean; verbose?: boolean } & LoginOptions,
): Promise<number> {
  const { catalog, source } = await loadCatalog({ refresh: opts.refresh === true });
  if (source === "seed") {
    console.error(yellow("could not reach models.dev — using the built-in provider list"));
  }

  const [command, verb, arg] = argv;
  if (command === "models") {
    try {
      console.log(modelsList(config, catalog, verb, opts.verbose === true));
      return EXIT_OK;
    } catch (e) {
      if (e instanceof ProviderNotFound) {
        console.error(red(e.message));
        return EXIT_ERROR;
      }
      throw e;
    }
  }

  switch (verb) {
    case undefined:
    case "list":
    case "ls":
      console.log(providersList(config, catalog));
      return EXIT_OK;
    case "login":
      return providersLogin(catalog, opts);
    case "logout":
      return providersLogout(arg, config);
    default:
      console.error(red(`unknown subcommand "${verb}" — try list, login, or logout`));
      return EXIT_ERROR;
  }
}
