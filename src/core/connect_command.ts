/**
 * `/connect` and `/models` — the catalog-driven halves of provider management.
 *
 * The flow is opencode's, step for step: pick a provider from a searchable list
 * of everything models.dev knows, pick a model, pick how to authenticate, hand
 * over the key. Nothing asks what "kind" the provider is, what its base URL is,
 * or what its context window costs — a catalog entry already answers all three,
 * which is the whole reason for choosing from a list rather than typing.
 *
 * Split from `provider_command.ts` because that file owns the typed wizard and
 * the registry subcommands; this one owns the pickers. They share the same
 * context object and the same registration tail.
 */
import {
  catalogModels,
  catalogProviders,
  isSupported,
  loadCatalog,
  providerConfigFrom,
  safeEndpoint,
  unsupportedReason,
  type Catalog,
  type CatalogProvider,
  type LoadedCatalog,
} from "../config/catalog.ts";
import type { ProviderDraft } from "../config/providers.ts";
import type { Config } from "../config/schema.ts";
import type { PickerItem } from "../tui/app/store.ts";
import {
  registerProvider,
  setRegistryModel,
  type ModelMetadata,
} from "./provider_registry.ts";
import {
  startRegistration,
  useProvider,
  type ProviderCommandCtx,
} from "./provider_command.ts";

/**
 * The dialogs these flows drive. Absent in a non-TTY session and under
 * `ROCKY_LEGACY_TUI=1`, where neither REPL has a dialog layer — those fall back
 * to the typed wizard, which is why it still exists.
 */
export type ProviderUi = {
  select(opts: {
    title: string;
    placeholder: string;
    items: PickerItem[];
  }): Promise<string | undefined>;
  prompt(opts: {
    title: string;
    hint: string;
    masked: boolean;
    placeholder?: string;
  }): Promise<string | undefined>;
};

export type CatalogLoader = (opts?: { refresh?: boolean }) => Promise<LoadedCatalog>;

/** Rows the catalog cannot supply: local Ollama, and opencode's "Other". */
export const OLLAMA_LOCAL = " ollama-local";
export const CUSTOM = " other";

const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";

export function connectItems(catalog: Catalog): PickerItem[] {
  const native: PickerItem[] = [
    { value: OLLAMA_LOCAL, label: "Ollama (local)", hint: `no auth · ${OLLAMA_DEFAULT_URL}` },
    { value: CUSTOM, label: "Other", hint: "custom endpoint, entered by hand" },
  ];

  return [
    ...native,
    ...catalogProviders(catalog).map((provider): PickerItem => {
      const count = Object.keys(provider.models).length;
      // Unsupported providers stay in the list and explain themselves on
      // selection, rather than silently going missing from a list users are
      // comparing against opencode's.
      return isSupported(provider)
        ? { value: provider.id, label: provider.name, hint: `${count} models` }
        : {
            value: provider.id,
            label: provider.name,
            hint: "unsupported",
            disabled: true,
            disabledReason: unsupportedReason(provider),
          };
    }),
  ];
}

const priceHint = (model: { limit?: { context?: number }; cost?: { input?: number; output?: number } }) => {
  const context = model.limit?.context;
  const input = model.cost?.input;
  const output = model.cost?.output;
  return [
    context ? `${Math.round(context / 1000)}k ctx` : undefined,
    input !== undefined && output !== undefined ? `$${input}/$${output} per Mtok` : undefined,
  ].filter(Boolean) as string[];
};

export function modelItems(provider: CatalogProvider): PickerItem[] {
  return catalogModels(provider).map((model) => {
    const parts = priceHint(model);
    if (model.reasoning) parts.push("reasoning");
    return {
      value: model.id,
      label: model.id,
      ...(parts.length > 0 ? { hint: parts.join(" · ") } : {}),
    };
  });
}

const catalogFor = (ctx: ProviderCommandCtx, refresh = false): Promise<LoadedCatalog> =>
  (ctx.loadCatalog ?? ((opts) => loadCatalog(opts ?? {})))({ refresh });

export async function runConnect(ctx: ProviderCommandCtx, refresh = false): Promise<void> {
  const ui = ctx.ui;
  if (!ui) {
    ctx.out("this terminal has no dialogs — falling back to the typed wizard");
    startRegistration(undefined, ctx);
    return;
  }

  const { catalog, source } = await catalogFor(ctx, refresh);
  if (source === "seed") {
    ctx.out("could not reach models.dev — showing only the providers Rocky knows built-in");
  }

  const providerId = await ui.select({
    title: "Add provider",
    placeholder: "type to filter…",
    items: connectItems(catalog),
  });
  if (providerId === undefined) return void ctx.out("cancelled — nothing was saved");
  if (providerId === CUSTOM) return startRegistration(undefined, ctx);
  if (providerId === OLLAMA_LOCAL) return connectOllama(ctx, ui);

  const provider = catalog[providerId];
  if (!provider) {
    ctx.out(`${providerId} is no longer in the catalog — try /connect refresh`);
    return;
  }
  if (!providerConfigFrom(provider)) {
    ctx.out(unsupportedReason(provider));
    return;
  }

  const model = await pickModel(ctx, ui, provider);
  if (model === undefined) return void ctx.out("cancelled — nothing was saved");

  if (!(await confirmCatalogEndpoint(ui, provider))) {
    return void ctx.out("cancelled — the catalog endpoint was not approved");
  }

  const auth = await pickAuthMethod(ui, provider);
  if (auth === undefined) return void ctx.out("cancelled — nothing was saved");

  // Re-derive with the model in hand: window and price are per model, not per
  // provider, and getting them from the catalog is the point of the exercise.
  const config = providerConfigFrom(provider, model)!;
  await finishRegistration(
    ctx,
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
    auth.secret,
  );
}

/**
 * Local Ollama is not in the catalog — only Ollama Cloud is — so its models
 * come from the daemon itself, via the same `/api/tags` the provider already
 * talks to.
 */
async function connectOllama(ctx: ProviderCommandCtx, ui: ProviderUi): Promise<void> {
  const tags = await listOllamaModels(ctx);
  const model =
    tags.length > 0
      ? await ui.select({
          title: "Ollama model",
          placeholder: "type to filter…",
          items: tags.map((name) => ({ value: name, label: name })),
        })
      : await promptForModel(ctx, ui);

  if (!model) return void ctx.out("cancelled — nothing was saved");
  await finishRegistration(ctx, { name: "ollama", kind: "ollama", model }, undefined);
}

async function promptForModel(
  ctx: ProviderCommandCtx,
  ui: ProviderUi,
): Promise<string | undefined> {
  ctx.out(`no local Ollama answered at ${OLLAMA_DEFAULT_URL} — enter a model id anyway`);
  return ui.prompt({
    title: "Ollama model",
    hint: "the id you would pass to `ollama run`",
    masked: false,
    placeholder: "qwen3:8b",
  });
}

async function listOllamaModels(ctx: ProviderCommandCtx): Promise<string[]> {
  try {
    const response = await (ctx.fetchImpl ?? fetch)(`${OLLAMA_DEFAULT_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { models?: { name?: string }[] };
    return (body.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
  } catch {
    return [];
  }
}

async function pickModel(
  ctx: ProviderCommandCtx,
  ui: ProviderUi,
  provider: CatalogProvider,
): Promise<string | undefined> {
  const items = modelItems(provider);
  if (items.length > 0) {
    return ui.select({
      title: `${provider.name} · model`,
      placeholder: "type to filter…",
      items,
    });
  }
  // A catalog entry that lists no models still deserves to be usable.
  ctx.out(`${provider.name} lists no models in the catalog — enter one by hand`);
  const typed = await ui.prompt({
    title: `${provider.name} · model`,
    hint: "the model id this endpoint expects",
    masked: false,
  });
  return typed === "" ? undefined : typed;
}

type AuthChoice = { secret?: string };

/** The host a key would be sent to, for the prompt. Undefined when Rocky's own default applies. */
export function endpointHost(provider: CatalogProvider): string | undefined {
  const api = safeEndpoint(provider.api);
  if (api === undefined) return undefined;
  try {
    return new URL(api).host;
  } catch {
    return undefined;
  }
}

/**
 * Catalog data is remote input. Choosing a provider is not consent to hand a
 * credential to whatever URL it happens to advertise, so require a deliberate
 * approval of the exact origin before that endpoint is persisted.
 */
async function confirmCatalogEndpoint(ui: ProviderUi, provider: CatalogProvider): Promise<boolean> {
  const api = safeEndpoint(provider.api);
  if (api === undefined) return true;
  const origin = new URL(api).origin;
  const answer = await ui.select({
    title: `${provider.name} · endpoint`,
    placeholder: "",
    items: [
      { value: "trust", label: `Trust ${origin}`, hint: "credentials will be sent here" },
      { value: "cancel", label: "Cancel", hint: "do not save this endpoint" },
    ],
  });
  return answer === "trust";
}

/**
 * opencode asks *how* to authenticate before asking for anything. Rocky offers
 * the two methods it supports; an OAuth row would slot in here without
 * reshaping the flow.
 */
async function pickAuthMethod(
  ui: ProviderUi,
  provider: CatalogProvider,
): Promise<AuthChoice | undefined> {
  const envVar = provider.env[0];
  // The endpoint comes from the catalog, and the key being typed is about to be
  // sent there on every request. Naming the host in the prompt is the cheapest
  // possible check on that: a redirected entry stops looking like the provider
  // it claims to be the moment its host is on screen.
  const host = endpointHost(provider);
  const items: PickerItem[] = [
    { value: "api", label: "API key", hint: "stored 0600 in ~/.rocky/credentials.json" },
  ];
  if (envVar) {
    items.push({
      value: "env",
      label: `Environment variable (${envVar})`,
      hint: process.env[envVar] ? "set in this shell" : "not set right now",
    });
  }

  const method = await ui.select({
    title: `${provider.name} · authentication`,
    placeholder: "",
    items,
  });
  if (method === undefined) return undefined;
  if (method === "env") return {};

  const key = await ui.prompt({
    title: `${provider.name} · API key`,
    hint:
      (host ? `sent to ${host} · ` : "") +
      (envVar
        ? `not echoed anywhere · Enter with nothing typed reads ${envVar} instead`
        : "not echoed anywhere"),
    masked: true,
  });
  if (key === undefined) return undefined;
  return key === "" ? {} : { secret: key };
}

/** Shared tail of every registration path: persist, mirror in memory, activate. */
async function finishRegistration(
  ctx: ProviderCommandCtx,
  draft: ProviderDraft,
  secret: string | undefined,
): Promise<void> {
  const saved = registerProvider(draft, secret, {
    ...(ctx.paths ?? {}),
    ...(secret === undefined ? { clearStoredCredential: true } : {}),
  });
  ctx.session.config.providers[draft.name] = {
    kind: draft.kind,
    reasoningEffort: false,
    ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
    ...(draft.apiKeyEnv === undefined ? {} : { apiKeyEnv: draft.apiKeyEnv }),
    ...(draft.contextWindow === undefined ? {} : { contextWindow: draft.contextWindow }),
    ...(draft.pricing === undefined ? {} : { pricing: draft.pricing }),
    ...(draft.catalogId === undefined ? {} : { catalogId: draft.catalogId }),
    model: draft.model,
  };
  ctx.out(
    `registered ${draft.name} · ${draft.kind} · ${draft.model}\n` +
      `  saved to ${saved.configPath}` +
      (saved.stored ? "\n  key stored 0600 in ~/.rocky/credentials.json" : ""),
  );
  await useProvider(draft.name, ctx, { alreadyPersisted: true });
}

/**
 * Every model reachable from the registry, as `provider/model` — opencode's
 * shape. A catalog-backed entry contributes its provider's whole model list; a
 * hand-written entry contributes only the model it names.
 */
export function allModelItems(config: Config, catalog: Catalog): PickerItem[] {
  const items: PickerItem[] = [];
  for (const [name, entry] of Object.entries(config.providers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const provider = entry.catalogId ? catalog[entry.catalogId] : undefined;
    const models = provider ? catalogModels(provider) : [];
    if (models.length === 0) {
      if (entry.model) {
        items.push({ value: `${name}/${entry.model}`, label: `${name}/${entry.model}` });
      }
      continue;
    }
    for (const model of models) {
      const parts = priceHint(model);
      items.push({
        value: `${name}/${model.id}`,
        label: `${name}/${model.id}`,
        ...(parts.length > 0 ? { hint: parts.join(" · ") } : {}),
      });
    }
  }
  return items;
}

export async function runModels(ctx: ProviderCommandCtx): Promise<void> {
  const { catalog } = await catalogFor(ctx);
  const items = allModelItems(ctx.session.config, catalog);

  if (items.length === 0) {
    ctx.out("no registered providers to pick a model from — /connect adds one");
    return;
  }
  if (!ctx.ui) {
    ctx.out(items.map((item) => `  ${item.label}`).join("\n"));
    ctx.out("this terminal has no dialogs — switch with /model <id>");
    return;
  }

  const picked = await ctx.ui.select({
    title: "Switch model",
    placeholder: "type to filter…",
    items,
  });
  if (picked === undefined) return;

  const slash = picked.indexOf("/");
  const name = picked.slice(0, slash);
  const model = picked.slice(slash + 1);
  const entry = ctx.session.config.providers[name];
  if (!entry) {
    ctx.out(`no provider named ${name}`);
    return;
  }

  // Window and price are per model, not per provider, so switching model has to
  // re-derive them. Carrying the previous model's numbers forward would size
  // compaction against a window this model does not have and bill every token
  // at the old model's rate — both silently.
  const meta = modelMetadata(entry.catalogId, model, catalog);
  const { contextWindow: _window, pricing: _pricing, ...rest } = entry;

  // Persist the model against its provider, so the next session starts here.
  ctx.session.config.providers[name] = {
    ...rest,
    model,
    ...(meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow }),
    ...(meta.pricing === undefined ? {} : { pricing: meta.pricing }),
  };
  setRegistryModel(name, model, meta, ctx.paths ?? {});
  await useProvider(name, ctx, {});
}

/**
 * What the catalog says about one model of one provider. Everything is
 * optional: a hand-written entry has no `catalogId`, a catalog entry can list a
 * model with no limits, and both cases must clear the numbers rather than keep
 * the ones that were there.
 */
export function modelMetadata(
  catalogId: string | undefined,
  model: string,
  catalog: Catalog,
): ModelMetadata {
  const provider = catalogId ? catalog[catalogId] : undefined;
  if (!provider) return {};
  const config = providerConfigFrom(provider, model);
  return {
    ...(config?.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
    ...(config?.pricing === undefined ? {} : { pricing: config.pricing }),
  };
}
