/**
 * Provider-agnostic conversation types.
 *
 * These are deliberately NOT the Anthropic SDK types. Providers adapt to/from
 * these shapes at their boundary, which is the only place `any`-ish casting is
 * tolerated. Everything above this line is strictly typed.
 */

export type TextBlock = { type: "text"; text: string };

/**
 * Thinking blocks must be round-tripped back to the provider byte-identical,
 * including `signature`. Never synthesize or edit one.
 */
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};

export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export type Role = "user" | "assistant";

/** One step of the agent's visible plan; todo_write replaces the whole list. */
export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type Message = {
  role: Role;
  content: ContentBlock[];
};

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | "aborted"
  // Loop-originated, never from a provider: the turn hit its iteration cap or
  // stalled against refused permissions. Distinct so a caller (the task tool)
  // can tell "finished" from "gave up" — a capped sub-agent once reported its
  // partial work as a complete report.
  | "max_iterations"
  | "denied";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheCreationInputTokens:
    a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
});

/** Total prompt size = uncached + written-to-cache + read-from-cache. */
export const promptTokens = (u: Usage): number =>
  u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** A system-prompt segment. `cache: true` requests a cache breakpoint here. */
export type SystemSegment = { text: string; cache?: boolean };

export type JSONSchema = Record<string, unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: JSONSchema;
};

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Assumed context window when a provider cannot tell us the model's real one —
 * every OpenAI-compatible endpoint and Ollama. Set `provider.contextWindow` in
 * config to correct it.
 *
 * 126k rather than a round 128k: this number drives the context meter and the
 * auto-compaction threshold, so it should sit just under a real window, not on
 * top of it. Overshooting means compaction fires too late.
 */
export const DEFAULT_CONTEXT_WINDOW = 126_000;

export type ProviderRequest = {
  model: string;
  system: SystemSegment[];
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  effort: Effort;
  thinking: boolean;
  signal: AbortSignal;
};

export type StreamEvent =
  | { type: "message_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partialJson: string }
  | { type: "block_end" }
  | {
      type: "message_end";
      message: Message;
      stopReason: StopReason;
      usage: Usage;
    };

export interface Provider {
  readonly name: string;
  /**
   * One-time discovery of a model's real limits and capabilities, called once
   * at session start. Must never throw: a provider that cannot introspect just
   * keeps its defaults.
   */
  prepare?(model: string, signal?: AbortSignal): Promise<void>;
  /** Context window in tokens for the given model. */
  contextWindow(model: string): number;
  /** Cost in USD per input/output token, for `/cost`. */
  pricing(model: string): { input: number; output: number };
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined>;
}

/** Thrown when the user interrupts a turn. Never a crash. */
export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}
