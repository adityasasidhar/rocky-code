/**
 * `/provider`, wired up: parsing and persistence joined to the running session.
 *
 * Both REPLs call in here — the Solid footer and the legacy editor duplicate
 * their command tables, and a provider you can only register in one of them is
 * a bug waiting to be filed. Output goes through an injected `out` so tests can
 * read what the user would have seen.
 *
 * Switching a provider mutates the session rather than rebuilding it: the
 * conversation, the todos, and the cost tally all survive changing which server
 * answers the next turn.
 */
import {
  CONFIG_ROW_NAME,
  PROVIDER_USAGE,
  advanceWizard,
  configProviderRow,
  describeKey,
  parseProviderCommand,
  providerRows,
  startWizard,
  wizardIsSecret,
  wizardPrompt,
  type Wizard,
} from "../config/providers.ts";
import type { NamedProvider, ProviderConfig } from "../config/schema.ts";
import { resolveApiKey } from "../config/credentials.ts";
import {
  activateProvider,
  entryToProviderConfig,
  forgetProvider,
  providerFor,
  registerProvider,
  type RegistryPaths,
} from "./provider_registry.ts";
import type { Session } from "./session.ts";
import type { CatalogLoader, ProviderUi } from "./connect_command.ts";

export type ProviderCommandCtx = {
  session: Session;
  /** What the session is talking to right now. */
  backendKind: () => "trueforge" | "local";
  /**
   * Move the session onto the local loop. `/provider use` is meaningless under
   * the TrueForge backend, which takes its model from `trueforge.model` — so
   * activating a provider there switches backends rather than quietly doing
   * nothing.
   */
  switchToLocal: () => void;
  out: (line: string) => void;
  /** The in-flight registration, if any. Owned by the REPL, mutated here. */
  wizard: { active: Wizard | null };
  paths?: RegistryPaths;
  /** Dialogs, when the terminal has them. Absent → the typed wizard is used. */
  ui?: ProviderUi;
  /** Injected in tests, so no unit test reaches models.dev or a live Ollama. */
  loadCatalog?: CatalogLoader;
  fetchImpl?: typeof fetch;
};

/** True while the next submitted line answers a wizard question. */
export const awaitingProviderAnswer = (ctx: ProviderCommandCtx): boolean =>
  ctx.wizard.active !== null;

/** True while that answer is a secret the REPL must not echo or store in history. */
export const awaitingSecret = (ctx: ProviderCommandCtx): boolean =>
  ctx.wizard.active !== null && wizardIsSecret(ctx.wizard.active);

export async function runProviderCommand(args: string, ctx: ProviderCommandCtx): Promise<void> {
  const command = parseProviderCommand(args);
  switch (command.kind) {
    case "error":
      ctx.out(`${command.message}\n${PROVIDER_USAGE}`);
      return;
    case "help":
      ctx.out(PROVIDER_USAGE);
      return;
    case "show":
      showActive(ctx);
      return;
    case "list":
      listProviders(ctx);
      return;
    case "add":
      startRegistration(command.name, ctx);
      return;
    case "use":
      await useProvider(command.name, ctx);
      return;
    case "remove":
      removeProvider(command.name, ctx);
      return;
  }
}

/** Feed one submitted line into the in-flight registration. */
export async function runProviderWizardLine(
  line: string,
  ctx: ProviderCommandCtx,
): Promise<void> {
  const wizard = ctx.wizard.active;
  if (!wizard) return;

  const result = advanceWizard(wizard, line);
  switch (result.kind) {
    case "cancelled":
      ctx.wizard.active = null;
      ctx.out("registration cancelled — nothing was saved");
      return;
    case "retry":
      ctx.wizard.active = result.wizard;
      ctx.out(`${result.message}\n${wizardPrompt(result.wizard)}`);
      return;
    case "next":
      ctx.wizard.active = result.wizard;
      ctx.out(wizardPrompt(result.wizard));
      return;
    case "done": {
      ctx.wizard.active = null;
      const { draft, secret } = result;
      const saved = registerProvider(draft, secret, ctx.paths ?? {});
      const entry: NamedProvider = {
        kind: draft.kind,
        reasoningEffort: false,
        ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
        ...(draft.apiKeyEnv === undefined ? {} : { apiKeyEnv: draft.apiKeyEnv }),
        model: draft.model,
      };
      ctx.session.config.providers[draft.name] = entry;
      ctx.out(
        `registered ${draft.name} · ${draft.kind} · ${draft.model}\n` +
          `  saved to ${saved.configPath}` +
          (saved.stored ? "\n  key stored 0600 in ~/.rocky/credentials.json" : ""),
      );
      await useProvider(draft.name, ctx, { alreadyPersisted: true });
      return;
    }
  }
}

export function startRegistration(name: string | undefined, ctx: ProviderCommandCtx): void {
  const wizard = startWizard(name);
  ctx.wizard.active = wizard;
  ctx.out(`${wizardPrompt(wizard)}\n  /cancel at any point abandons the registration`);
}

function showActive(ctx: ProviderCommandCtx): void {
  const { config } = ctx.session;
  const name = config.activeProvider;
  const entry = name ? config.providers[name] : undefined;
  const row =
    name && entry
      ? { ...providerRows(config, () => keySourceFor(ctx, name, entry))[0]!, model: ctx.session.model }
      : { ...configProviderRow(config, () => keySourceFor(ctx, undefined, config.provider)), model: ctx.session.model };

  ctx.out(
    `${name ?? CONFIG_ROW_NAME} · ${row.kind} · ${row.model}\n` +
      `  endpoint  ${row.endpoint}\n` +
      `  auth      ${describeKey(row)}\n` +
      `  backend   ${ctx.backendKind()}` +
      (name === undefined
        ? `\n  ${CONFIG_ROW_NAME} — configured directly, not in the registry. /provider add registers a named one.`
        : "") +
      (ctx.backendKind() === "trueforge"
        ? "\n  TrueForge drives the model; /provider use switches to the local loop"
        : ""),
  );
}

/** One place that decides where a key comes from, so every view agrees. */
function keySourceFor(
  ctx: ProviderCommandCtx,
  name: string | undefined,
  cfg: { kind: ProviderConfig["kind"]; apiKeyEnv?: string | undefined },
) {
  return resolveApiKey(cfg, {
    name,
    ...(ctx.paths?.credentials ? { path: ctx.paths.credentials } : {}),
  }).source;
}

function listProviders(ctx: ProviderCommandCtx): void {
  const { config } = ctx.session;
  const rows = providerRows(config, (name, entry) => keySourceFor(ctx, name, entry));
  // The config-file provider is not in the registry but is the one answering
  // turns, so it leads the list rather than being invisible.
  if (config.activeProvider === undefined) {
    rows.unshift({
      ...configProviderRow(config, (cfg) => keySourceFor(ctx, undefined, cfg)),
      model: ctx.session.model,
    });
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  ctx.out(
    rows
      .map(
        (r) =>
          `${r.active ? "*" : " "} ${r.name.padEnd(width)}  ${r.kind} · ${r.model} · ${describeKey(r)}`,
      )
      .join("\n") +
      (rows.length === 1 && config.activeProvider === undefined
        ? `\n  ${CONFIG_ROW_NAME} comes from your config, not the registry — /provider add registers one you can switch to by name`
        : ""),
  );
}

export async function useProvider(
  name: string,
  ctx: ProviderCommandCtx,
  opts: { alreadyPersisted?: boolean } = {},
): Promise<void> {
  const { config } = ctx.session;
  const entry = config.providers[name];
  if (!entry) {
    const known = Object.keys(config.providers);
    ctx.out(
      `no provider named ${name}` +
        (known.length > 0 ? ` — registered: ${known.join(", ")}` : " — /provider add registers one"),
    );
    return;
  }

  const providerConfig = entryToProviderConfig({ ...entry });
  const model = entry.model ?? config.model;
  let built;
  try {
    built = providerFor(providerConfig, name, ctx.paths ?? {});
  } catch (e) {
    ctx.out(`cannot use ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Re-probe before accounting: a different server has a different window and
  // may or may not think.
  await built.provider.prepare?.(model).catch(() => undefined);

  ctx.session.provider = built.provider;
  ctx.session.model = model;
  config.provider = providerConfig;
  config.activeProvider = name;

  const switching = ctx.backendKind() === "trueforge";
  if (switching) ctx.switchToLocal();
  if (!opts.alreadyPersisted) activateProvider(name, ctx.paths ?? {});

  ctx.out(
    `provider → ${name} · ${model} (${built.provider.name})` +
      (built.source === "none" && providerConfig.kind !== "ollama"
        ? `\n  warning: no key found — set ${built.envVar ?? "an env var"} or re-run /provider add`
        : "") +
      (switching ? "\n  backend → local (TrueForge owns its own model; this session now runs the local loop)" : ""),
  );
}

function removeProvider(name: string, ctx: ProviderCommandCtx): void {
  const { config } = ctx.session;
  if (!config.providers[name]) {
    ctx.out(`no provider named ${name}`);
    return;
  }
  const result = forgetProvider(name, ctx.paths ?? {});
  delete config.providers[name];
  if (result.wasActive) delete config.activeProvider;

  ctx.out(
    `removed ${name}` +
      (result.removedKey ? " and its stored key" : "") +
      (result.wasActive
        ? "\n  it was active — this session keeps using it until you /provider use another"
        : ""),
  );
}
