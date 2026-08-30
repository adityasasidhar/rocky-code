/**
 * `/provider`: the runtime provider registry, as pure functions over strings.
 *
 * All the decisions live here — what a subcommand means, what the wizard asks
 * next, whether an answer is usable — so they are testable without a terminal,
 * a filesystem, or a network. `cli.ts` owns every side effect: printing,
 * writing the config, storing the key, swapping the live backend.
 *
 * The wizard is a reducer, not a sequence of awaited prompts. That is what lets
 * one implementation drive both REPLs: each submitted line is fed to
 * `advanceWizard`, and neither the Solid footer nor the legacy editor has to
 * learn how to block for input mid-command.
 */
import {
  ProviderKindSchema,
  ProviderNameSchema,
  defaultApiKeyEnv,
  defaultBaseUrl,
  type Config,
  type NamedProvider,
  type ProviderConfig,
  type ProviderKind,
} from "./schema.ts";
import type { KeySource } from "./credentials.ts";

// ---------------------------------------------------------------- subcommands

export type ProviderCommand =
  | { kind: "show" }
  | { kind: "list" }
  | { kind: "add"; name?: string }
  | { kind: "use"; name: string }
  | { kind: "remove"; name: string }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const PROVIDER_USAGE = [
  "/provider                    show the active provider",
  "/provider list               registered providers and where each key comes from",
  "/provider add [name]         register one, step by step",
  "/provider use <name>         switch to it now, and for future sessions",
  "/provider remove <name>      forget it, and its stored key",
].join("\n");

/** Parses everything after `/provider`. Unknown words are an error, not a prompt. */
export function parseProviderCommand(args: string): ProviderCommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const [verb, arg] = parts;
  if (verb === undefined) return { kind: "show" };
  if (parts.length > 2) {
    return { kind: "error", message: `/provider takes at most one argument, got ${parts.length}` };
  }

  switch (verb) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "help":
      return { kind: "help" };
    case "add":
    case "login":
      if (arg === undefined) return { kind: "add" };
      return nameError(arg) ?? { kind: "add", name: arg };
    case "use":
    case "switch":
      if (arg === undefined) return { kind: "error", message: "/provider use needs a name" };
      return nameError(arg) ?? { kind: "use", name: arg };
    case "remove":
    case "rm":
    case "logout":
      if (arg === undefined) return { kind: "error", message: "/provider remove needs a name" };
      return nameError(arg) ?? { kind: "remove", name: arg };
    default:
      return {
        kind: "error",
        message: `unknown subcommand "${verb}" — try list, add, use, or remove`,
      };
  }
}

function nameError(name: string): { kind: "error"; message: string } | undefined {
  const parsed = ProviderNameSchema.safeParse(name);
  if (parsed.success) return undefined;
  return {
    kind: "error",
    message: `"${name}" is not a usable provider name — lowercase letters, digits, . _ - only`,
  };
}

// -------------------------------------------------------------------- listing

export type ProviderRow = {
  name: string;
  active: boolean;
  kind: ProviderKind;
  model: string;
  endpoint: string;
  key: KeySource;
  keyEnv: string | undefined;
};

/**
 * One row per registered provider. `keySource` is injected so this stays pure —
 * the caller decides whether that means reading the environment, a credentials
 * file, or a test fixture.
 */
export function providerRows(
  config: Config,
  keySource: (name: string, entry: NamedProvider) => KeySource,
): ProviderRow[] {
  return Object.entries(config.providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      active: config.activeProvider === name,
      kind: entry.kind,
      model: entry.model ?? config.model,
      endpoint: entry.baseUrl ?? defaultBaseUrl(entry.kind) ?? "(sdk default)",
      key: entry.kind === "ollama" ? "none" : keySource(name, entry),
      keyEnv: entry.apiKeyEnv ?? defaultApiKeyEnv(entry.kind),
    }));
}

/**
 * The provider a config file set up directly, rendered as a row.
 *
 * It has no registry name, but `/provider list` still has to show it: saying
 * "no providers registered yet" while a provider is plainly answering every
 * turn reads as a broken command, not as an empty registry.
 */
export function configProviderRow(
  config: Config,
  keySource: (entry: ProviderConfig) => KeySource,
): ProviderRow {
  return {
    name: CONFIG_ROW_NAME,
    active: true,
    kind: config.provider.kind,
    model: config.model,
    endpoint: config.provider.baseUrl ?? defaultBaseUrl(config.provider.kind) ?? "(sdk default)",
    key: config.provider.kind === "ollama" ? "none" : keySource(config.provider),
    keyEnv: config.provider.apiKeyEnv ?? defaultApiKeyEnv(config.provider.kind),
  };
}

/** Stands in for a name in listings; deliberately not a usable `/provider use` argument. */
export const CONFIG_ROW_NAME = "(config file)";

/** How a row's credential reads in `/provider list`. Never shows a value. */
export function describeKey(row: ProviderRow): string {
  if (row.kind === "ollama") return "no auth";
  switch (row.key) {
    case "env":
      return `key via ${row.keyEnv ?? "env"}`;
    case "stored":
      return "key stored";
    case "none":
      return `no key (set ${row.keyEnv ?? "an env var"})`;
  }
}

// --------------------------------------------------------------------- wizard

export type WizardStep = "kind" | "name" | "baseUrl" | "model" | "key";

export type ProviderDraft = {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  apiKeyEnv?: string;
  /** Catalog-supplied, so a picked provider needs no follow-up questions. */
  contextWindow?: number;
  pricing?: { input: number; output: number };
  catalogId?: string;
};

export type Wizard = {
  step: WizardStep;
  draft: Partial<ProviderDraft>;
};

export type WizardResult =
  | { kind: "next"; wizard: Wizard }
  /** The answer was unusable; ask the same question again. */
  | { kind: "retry"; wizard: Wizard; message: string }
  | { kind: "done"; draft: ProviderDraft; secret?: string }
  | { kind: "cancelled" };

const KINDS = ProviderKindSchema.options;

/** Ollama is the only kind that needs no credential, so it skips the key step. */
const needsKey = (kind: ProviderKind): boolean => kind !== "ollama";

/** Anthropic's SDK resolves its own endpoint; asking for one invites a typo'd URL. */
const asksBaseUrl = (kind: ProviderKind): boolean => kind !== "anthropic";

export function startWizard(name?: string): Wizard {
  return { step: "kind", draft: name === undefined ? {} : { name } };
}

/** The question for the current step, already worded for the terminal. */
export function wizardPrompt(wizard: Wizard): string {
  const kind = wizard.draft.kind;
  switch (wizard.step) {
    case "kind":
      return `kind? ${KINDS.map((k, i) => `${i + 1}) ${k}`).join("  ")}`;
    case "name":
      return "name for this provider? (what you'll type after /provider use)";
    case "baseUrl": {
      const fallback = kind ? defaultBaseUrl(kind) : undefined;
      return fallback
        ? `base URL? (Enter for ${fallback})`
        : "base URL? (e.g. http://127.0.0.1:8080/v1)";
    }
    case "model":
      return "model?";
    case "key": {
      const envVar = (kind && defaultApiKeyEnv(kind)) ?? "an env var";
      return (
        `API key? (not echoed to scrollback; stored 0600 in ~/.rocky/credentials.json)\n` +
        `  · Enter to skip and read ${envVar} from the environment instead\n` +
        `  · env:NAME to read a different variable`
      );
    }
  }
}

/** True while the next answer is a secret: the caller must not echo or log it. */
export const wizardIsSecret = (wizard: Wizard): boolean => wizard.step === "key";

export function advanceWizard(wizard: Wizard, input: string): WizardResult {
  const answer = input.trim();
  if (answer === "/cancel" || answer === "/abort") return { kind: "cancelled" };

  switch (wizard.step) {
    case "kind": {
      const kind = parseKind(answer);
      if (!kind) {
        return {
          kind: "retry",
          wizard,
          message: `pick one of: ${KINDS.join(", ")} (or 1-${KINDS.length})`,
        };
      }
      return proceed({ ...wizard.draft, kind }, "kind");
    }

    case "name": {
      const parsed = ProviderNameSchema.safeParse(answer);
      if (!parsed.success) {
        return {
          kind: "retry",
          wizard,
          message: "lowercase letters, digits, . _ - only — e.g. groq, local-llama",
        };
      }
      return proceed({ ...wizard.draft, name: parsed.data }, "name");
    }

    case "baseUrl": {
      const kind = wizard.draft.kind;
      if (answer === "") {
        // Empty means "the default for this kind", which we deliberately do not
        // write down: pinning it now would freeze a URL that may move later.
        if (kind && defaultBaseUrl(kind)) {
          return proceed(wizard.draft, "baseUrl");
        }
        return { kind: "retry", wizard, message: "this kind has no default — a base URL is required" };
      }
      if (!isHttpUrl(answer)) {
        return { kind: "retry", wizard, message: "that is not an http(s) URL" };
      }
      return proceed({ ...wizard.draft, baseUrl: answer }, "baseUrl");
    }

    case "model": {
      if (answer === "") return { kind: "retry", wizard, message: "a model id is required" };
      return proceed({ ...wizard.draft, model: answer }, "model");
    }

    case "key": {
      const draft = complete(wizard.draft);
      if (!draft) {
        // Unreachable via the wizard; a corrupt state should not persist junk.
        return { kind: "retry", wizard, message: "the registration is incomplete — start over" };
      }
      if (answer === "") return { kind: "done", draft };

      const named = /^(?:env:|\$)([A-Z][A-Z0-9_]*)$/.exec(answer);
      if (named?.[1]) return { kind: "done", draft: { ...draft, apiKeyEnv: named[1] } };
      if (/^env:/i.test(answer) || answer.startsWith("$")) {
        return {
          kind: "retry",
          wizard,
          message: "environment variable names are UPPER_SNAKE_CASE, e.g. env:GROQ_API_KEY",
        };
      }
      return { kind: "done", draft, secret: answer };
    }
  }
}

/**
 * The next question after `from`, or `undefined` when there are none left.
 * Kinds skip what they cannot use: anthropic resolves its own endpoint, ollama
 * needs no credential, and a name supplied as `/provider add groq` is not asked
 * for twice.
 */
function nextStep(draft: Partial<ProviderDraft>, from: WizardStep): WizardStep | undefined {
  const kind = draft.kind;
  const order: WizardStep[] = ["kind", "name", "baseUrl", "model", "key"];
  for (let index = order.indexOf(from) + 1; index < order.length; index += 1) {
    const next = order[index];
    if (next === undefined) return undefined;
    const skip =
      (next === "name" && draft.name !== undefined) ||
      (next === "baseUrl" && (kind === undefined || !asksBaseUrl(kind))) ||
      (next === "key" && (kind === undefined || !needsKey(kind)));
    if (!skip) return next;
  }
  return undefined;
}

/**
 * Move to the next question, or finish. A kind with no key step (ollama) ends
 * at `model`, so "answered the last question" and "asked for a secret" are not
 * the same moment — this is where that distinction is made.
 */
function proceed(draft: Partial<ProviderDraft>, from: WizardStep): WizardResult {
  const next = nextStep(draft, from);
  if (next !== undefined) return { kind: "next", wizard: { step: next, draft } };
  const finished = complete(draft);
  if (!finished) {
    return {
      kind: "retry",
      wizard: { step: from, draft },
      message: "the registration is incomplete — start over with /provider add",
    };
  }
  return { kind: "done", draft: finished };
}

function complete(draft: Partial<ProviderDraft>): ProviderDraft | undefined {
  const { name, kind, model } = draft;
  if (name === undefined || kind === undefined || model === undefined) return undefined;
  return {
    name,
    kind,
    model,
    ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
    ...(draft.apiKeyEnv === undefined ? {} : { apiKeyEnv: draft.apiKeyEnv }),
  };
}

function parseKind(answer: string): ProviderKind | undefined {
  const lowered = answer.toLowerCase();
  const byIndex = Number(lowered);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= KINDS.length) {
    return KINDS[byIndex - 1];
  }
  return KINDS.find((k) => k === lowered);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The registry entry a finished draft becomes, ready to merge into raw config. */
export function draftToEntry(draft: ProviderDraft): Record<string, unknown> {
  return {
    kind: draft.kind,
    ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
    ...(draft.apiKeyEnv === undefined ? {} : { apiKeyEnv: draft.apiKeyEnv }),
    ...(draft.contextWindow === undefined ? {} : { contextWindow: draft.contextWindow }),
    ...(draft.pricing === undefined ? {} : { pricing: draft.pricing }),
    ...(draft.catalogId === undefined ? {} : { catalogId: draft.catalogId }),
    model: draft.model,
  };
}
