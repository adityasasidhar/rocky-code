import { z } from "zod";

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const PermissionModeSchema = z.enum(["ask", "auto-edit", "yolo", "plan"]);

export const BackendKindSchema = z.enum(["trueforge", "local"]);

export const WorkerKindSchema = z.enum(["codex", "claude", "opencode", "fixture"]);

function isPinnedImage(image: string): boolean {
  if (/^.+@sha256:[a-f0-9]{64}$/i.test(image)) return true;
  const last = image.split("/").at(-1) ?? "";
  return last.includes(":") && !last.endsWith(":latest");
}

export const WorkerProfileSchema = z.object({
  enabled: z.boolean().default(false),
  kind: WorkerKindSchema,
  /** Pinned, locally-built image. Tags such as `latest` are rejected. */
  image: z.string().min(1).refine(isPinnedImage, {
    message: "worker images must use an explicit version tag or sha256 digest",
  }),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
  capabilities: z.array(z.string().min(1)).default([]),
  costTier: z.number().int().min(0).max(5).default(2),
  concurrency: z.number().int().positive().max(8).default(1),
  /** Only these provider credential variables are forwarded to the container. */
  credentialEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
});

export const TrueForgeConfigSchema = z.object({
  baseUrl: z.string().url().default("http://127.0.0.1:8790"),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("TRUEFORGE_TOKEN"),
  /** Existing named agent. Omit to create an inline Rocky orchestration agent. */
  agent: z.string().min(1).optional(),
  /** TrueForge model FQN, for example `anthropic/claude-sonnet-4-5`. */
  model: z.string().min(1).optional(),
  brokerMcpName: z.string().min(1).default("rocky-worker-broker"),
  sandbox: z.boolean().default(true),
  dynamicSubagents: z.boolean().default(true),
});

export const BrokerConfigSchema = z.object({
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(1024).max(65_535).default(8791),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("ROCKY_BROKER_TOKEN"),
  maxSnapshotBytes: z.number().int().positive().default(50 * 1024 * 1024),
  secretPatterns: z.array(z.string().min(1)).default([]),
  maxRecoveryAttempts: z.number().int().min(1).max(3).default(3),
  workers: z.record(z.string().min(1), WorkerProfileSchema).default({}),
});

export const ProviderKindSchema = z.enum([
  /** Anthropic Messages API. Full support: thinking, effort, prompt caching. */
  "anthropic",
  /** api.openai.com/v1/chat/completions. */
  "openai",
  /** Any OpenAI-compatible server: llama.cpp, vLLM, LM Studio, OpenRouter. */
  "openai-compatible",
  /** MiniMax's OpenAI-compatible /v1/chat/completions API. */
  "minimax",
  /** Ollama's native /api/chat. Exposes `thinking` and local token counts. */
  "ollama",
]);

export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  kind: ProviderKindSchema.default("anthropic"),
  /** Overrides the kind's default endpoint. */
  baseUrl: z.string().url().optional(),
  /** Env var holding the API key. Defaults per kind; unused by ollama. */
  apiKeyEnv: z.string().optional(),

  /** Required for non-Anthropic models: Rocky cannot know their limits. */
  contextWindow: z.number().int().positive().optional(),
  /** USD per token, for /cost. Local models are free; omit or set to 0. */
  pricing: z
    .object({ input: z.number().min(0), output: z.number().min(0) })
    .optional(),

  /**
   * Send `reasoning_effort` (OpenAI). Only valid for reasoning models —
   * a chat model will reject the request, so this is opt-in.
   */
  reasoningEffort: z.boolean().default(false),
  /**
   * Force `think` on or off (Ollama). Left unset, Rocky asks the model whether
   * it supports thinking and decides accordingly.
   */
  think: z.boolean().optional(),
});

/**
 * A provider saved under a name by `/provider add`. Identical to the singular
 * `provider` block plus the model it defaults to, so activating one is a
 * wholesale swap rather than a merge: a half-configured entry must not inherit
 * `baseUrl` or `think` from whatever was configured before it.
 */
export const NamedProviderSchema = ProviderConfigSchema.extend({
  /** Becomes the session's `model` when this provider is activated. */
  model: z.string().min(1).optional(),
  /**
   * The models.dev provider this came from. Present only for entries added by
   * picking from the catalog, and only so `/models` knows whose model list to
   * offer — a hand-written entry that happens to share a name is not the same
   * provider.
   */
  catalogId: z.string().min(1).optional(),
});

/** Registry keys are what the user types after `/provider use`. */
export const ProviderNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "provider names are lowercase [a-z0-9._-]")
  .max(64);

export const ConfigSchema = z.object({
  /** TrueForge owns the default root loop; `local` preserves Rocky's original loop. */
  backend: BackendKindSchema.default("trueforge"),
  trueforge: TrueForgeConfigSchema.default({
    baseUrl: "http://127.0.0.1:8790",
    tokenEnv: "TRUEFORGE_TOKEN",
    brokerMcpName: "rocky-worker-broker",
    sandbox: true,
    dynamicSubagents: true,
  }),
  broker: BrokerConfigSchema.default({
    host: "127.0.0.1",
    port: 8791,
    tokenEnv: "ROCKY_BROKER_TOKEN",
    maxSnapshotBytes: 50 * 1024 * 1024,
    secretPatterns: [],
    maxRecoveryAttempts: 3,
    workers: {},
  }),
  provider: ProviderConfigSchema.default({
    kind: "anthropic",
    reasoningEffort: false,
  }),
  /**
   * Providers registered at runtime by `/provider add`. Purely a registry:
   * nothing here takes effect until `activeProvider` names one.
   */
  providers: z.record(ProviderNameSchema, NamedProviderSchema).default({}),
  /** Which entry of `providers` supplies `provider`/`model`. See load.ts. */
  activeProvider: ProviderNameSchema.optional(),

  model: z.string().default("claude-opus-4-8"),
  maxTokens: z.number().int().positive().max(128_000).default(32_000),
  effort: EffortSchema.default("high"),
  thinking: z.boolean().default(true),

  /** UI theme: "opencode" (default), "dracula", "zenburn", "plain", or path to custom theme. */
  theme: z.string().default("opencode"),

  permissionMode: PermissionModeSchema.default("ask"),
  /** Command prefixes always allowed without a prompt, e.g. ["git status"]. */
  allow: z.array(z.string()).default([]),
  /** Command prefixes never allowed, e.g. ["rm -rf", "git push --force"]. */
  deny: z.array(z.string()).default([]),

  /** Default bash timeout in ms. Per-call override is clamped to `bashMaxTimeoutMs`. */
  bashTimeoutMs: z.number().int().positive().default(120_000),
  bashMaxTimeoutMs: z.number().int().positive().default(600_000),

  /** Max bytes of a tool result shown to the model before head/tail truncation. */
  maxToolResultBytes: z.number().int().positive().default(30_000),
  /** Max bytes read_file will return in one call. */
  maxFileReadBytes: z.number().int().positive().default(256_000),

  /** Fraction of the context window at which auto-compaction fires. */
  compactThreshold: z.number().min(0.1).max(0.99).default(0.8),

  /**
   * Post-edit check: run after any batch that successfully edited or wrote a
   * file, from the project root. Failures are fed back to the model in the
   * same message as the tool results, so it fixes what it just broke *now*
   * instead of reporting success. Keep the command fast — it runs per batch.
   */
  check: z
    .object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().default(60_000),
      maxOutputBytes: z.number().int().positive().default(4_000),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type NamedProvider = z.infer<typeof NamedProviderSchema>;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type BackendKind = z.infer<typeof BackendKindSchema>;
export type WorkerKind = z.infer<typeof WorkerKindSchema>;
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const defaultConfig = (): Config => ConfigSchema.parse({});

export function defaultApiKeyEnv(kind: ProviderKind): string | undefined {
  switch (kind) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openai-compatible":
      return "OPENAI_API_KEY";
    case "minimax":
      return "MINIMAX_API_KEY";
    case "ollama":
      return undefined; // local, no auth
  }
}

export function defaultBaseUrl(kind: ProviderKind): string | undefined {
  switch (kind) {
    case "anthropic":
      return undefined; // the SDK knows
    case "openai":
      return "https://api.openai.com/v1";
    case "openai-compatible":
      return undefined; // must be configured
    case "minimax":
      return "https://api.minimax.io/v1";
    case "ollama":
      return "http://127.0.0.1:11434";
  }
}
