import type {
  ContentBlock,
  Message,
  Provider,
  ProviderRequest,
  StopReason,
  StreamEvent,
  Usage,
} from "../types.ts";
import { DEFAULT_CONTEXT_WINDOW, emptyUsage } from "../types.ts";
import { iterateNdjson, postStream } from "./stream_util.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type OllamaToolCall = {
  function: { name: string; arguments: Record<string, unknown> };
};

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

type OllamaChunk = {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

/**
 * Ceiling for an auto-discovered context window: the same 126k the rest of
 * Rocky defaults to, so a capable model always runs at the full default.
 *
 * This started life at 32k on a local-hardware argument (a 262k KV cache runs
 * to tens of gigabytes), but in practice Rocky drives cloud-hosted Ollama
 * models where that caution only wastes context — 126k it is, by decree. A
 * model *trained* for less keeps its real, smaller window (padding it up would
 * be a lie Ollama acts on), and `provider.contextWindow` still overrides in
 * either direction, including past the cap.
 */
export const AUTO_CONTEXT_CAP = DEFAULT_CONTEXT_WINDOW;

export type OllamaProviderOptions = {
  baseUrl: string;
  /**
   * Overrides whatever `prepare()` discovers. Sent as `options.num_ctx`.
   *
   * Without a `num_ctx`, Ollama applies its own default (commonly 4096) and
   * *silently truncates* longer prompts — the model quietly loses the head of
   * its prompt, usually the system prompt, while Rocky's meter reports plenty
   * of headroom. The number we account against and the number we send are
   * always the same, so the two cannot drift.
   */
  contextWindow?: number;
  /**
   * Force `think` on or off. Left unset, `prepare()` enables it for models that
   * report the `thinking` capability and omits it for those that do not —
   * Ollama errors when a non-thinking model is told to think.
   */
  think?: boolean;
  headers?: Record<string, string>;
};

/** The subset of /api/show that we read. */
type ShowResponse = {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
};

/**
 * Pull the context length out of `model_info`, whose key is namespaced by
 * architecture: `qwen35.context_length`, `llama.context_length`, …
 */
export function parseContextLength(
  info: Record<string, unknown> | undefined,
): number | undefined {
  if (!info) return undefined;
  const arch = info["general.architecture"];
  const keys =
    typeof arch === "string"
      ? [`${arch}.context_length`, ...Object.keys(info)]
      : Object.keys(info);

  for (const key of keys) {
    if (!key.endsWith(".context_length")) continue;
    const value = info[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Ollama's native /api/chat.
 *
 * Preferred over Ollama's OpenAI compatibility layer because it streams the
 * `thinking` field for reasoning models and reports real token counts.
 *
 * Two quirks drive the code below:
 *   1. Tool calls carry no id. We synthesize stable ids and resolve them back
 *      to tool names when replaying history, because Ollama identifies tool
 *      results by `tool_name`, not by id.
 *   2. Tool arguments arrive as a parsed object, not a JSON string.
 */
/** Startup probe budget. Long enough for a cold daemon, short enough to notice. */
const PREPARE_TIMEOUT_MS = 5_000;

export class OllamaProvider implements Provider {
  readonly name = "ollama";

  /** Filled in by `prepare()`. Undefined until then. */
  private discoveredWindow: number | undefined;
  private supportsThinking: boolean | undefined;

  constructor(private readonly opts: OllamaProviderOptions) {}

  /**
   * Ask Ollama what this model can actually do. Best effort: a server that is
   * down, a model that is not pulled, or an unexpected payload all leave the
   * defaults in place, and the failure surfaces on the first real request
   * instead — where the error message is far more useful.
   */
  async prepare(model: string, signal?: AbortSignal): Promise<void> {
    let show: ShowResponse;
    try {
      const res = await fetch(`${this.base()}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.opts.headers },
        body: JSON.stringify({ model }),
        // This runs before the first prompt, so an unresponsive daemon would
        // hang startup with nothing on screen. Bounded even when the caller
        // passes no signal of its own.
        signal: signal ?? AbortSignal.timeout(PREPARE_TIMEOUT_MS),
      });
      if (!res.ok) return;
      show = (await res.json()) as ShowResponse;
    } catch {
      return;
    }

    const trained = parseContextLength(show.model_info);
    if (trained) this.discoveredWindow = Math.min(trained, AUTO_CONTEXT_CAP);
    if (Array.isArray(show.capabilities)) {
      this.supportsThinking = show.capabilities.includes("thinking");
    }
  }

  /** The window we account against — always the same number we request. */
  contextWindow(): number {
    return this.opts.contextWindow ?? this.discoveredWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  /** Local inference is free. */
  pricing() {
    return { input: 0, output: 0 };
  }

  private base(): string {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  /** Explicit config wins; otherwise use what we discovered, or say nothing. */
  private numCtx(): number | undefined {
    return this.opts.contextWindow ?? this.discoveredWindow;
  }

  /**
   * Whether this model understands `think` at all.
   *
   * This is not the same question as "should it think now". A reasoning model
   * reasons *by default*: omitting `think` does not turn it off. So whenever the
   * model can think we must state the answer explicitly, including `false`.
   * Conversely, sending `think` to a model that cannot think is an error, so for
   * those we say nothing.
   */
  private thinkAware(): boolean {
    return this.opts.think !== undefined || (this.supportsThinking ?? false);
  }

  /** Explicit config wins over what the model reports about itself. */
  private thinkAllowed(): boolean {
    return this.opts.think ?? this.supportsThinking ?? false;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const messages: OllamaMessage[] = [
      { role: "system", content: req.system.map((s) => s.text).join("\n\n") },
      ...toOllamaMessages(req.messages),
    ];

    const options: Record<string, number> = { num_predict: req.maxTokens };
    const numCtx = this.numCtx();
    if (numCtx) options["num_ctx"] = numCtx;

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      options,
    };
    if (req.tools.length > 0) {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }
    // `think: false` is as important as `think: true`: without it a reasoning
    // model ignores --no-thinking and reasons anyway.
    if (this.thinkAware()) body["think"] = req.thinking && this.thinkAllowed();

    yield { type: "message_start" };

    // The fetch itself can reject on abort: a server may withhold response
    // headers until its first chunk, so this must be inside the guard too.
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await postStream(
        `${this.base()}/api/chat`,
        body,
        { ...this.opts.headers },
        req.signal,
      );
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield abortedEnd("");
        return;
      }
      throw err;
    }

    const calls: { id: string; name: string; input: unknown }[] = [];
    let text = "";
    let doneReason: string | undefined;
    let usage: Usage = emptyUsage();

    try {
      for await (const chunk of iterateNdjson<OllamaChunk>(stream)) {
        // Ollama reports model-level failures inside a 200 stream.
        if (chunk.error) throw new Error(`ollama: ${chunk.error}`);

        const msg = chunk.message;
        if (msg?.thinking) yield { type: "thinking_delta", text: msg.thinking };
        if (msg?.content) {
          text += msg.content;
          yield { type: "text_delta", text: msg.content };
        }

        for (const call of msg?.tool_calls ?? []) {
          const id = `call_${calls.length}_${call.function.name}`;
          calls.push({ id, name: call.function.name, input: call.function.arguments });
          yield { type: "tool_use_start", id, name: call.function.name };
        }

        if (chunk.done) {
          doneReason = chunk.done_reason;
          usage = {
            inputTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          };
        }
      }
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield abortedEnd(text);
        return;
      }
      throw err;
    }

    if (req.signal.aborted) {
      yield abortedEnd(text);
      return;
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const c of calls) {
      content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }

    yield {
      type: "message_end",
      message: { role: "assistant", content },
      stopReason: calls.length > 0 ? "tool_use" : mapDoneReason(doneReason),
      usage,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Ollama matches tool results to calls by `tool_name`, so we recover the name
 * from the assistant turn that issued the call rather than trusting the id.
 */
export function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const nameById = new Map<string, string>();

  for (const msg of messages) {
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      for (const r of results) {
        out.push({
          role: "tool",
          content: r.content,
          tool_name: nameById.get(r.tool_use_id) ?? "",
        });
      }
      const text = textOf(msg.content);
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    if (msg.role === "user") {
      out.push({ role: "user", content: textOf(msg.content) });
      continue;
    }

    const calls = msg.content.filter((b) => b.type === "tool_use");
    for (const c of calls) nameById.set(c.id, c.name);

    const assistant: OllamaMessage = { role: "assistant", content: textOf(msg.content) };
    if (calls.length > 0) {
      assistant.tool_calls = calls.map((c) => ({
        function: {
          name: c.name,
          arguments: (c.input ?? {}) as Record<string, unknown>,
        },
      }));
    }
    if (assistant.content || assistant.tool_calls) out.push(assistant);
  }
  return out;
}

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

export function mapDoneReason(reason: string | undefined): StopReason {
  return reason === "length" ? "max_tokens" : "end_turn";
}

const abortedEnd = (text: string): StreamEvent => ({
  type: "message_end",
  message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
  stopReason: "aborted",
  usage: emptyUsage(),
});

/** fetch rejects with a DOMException, which is not an Error in every runtime. */
function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (err as { name?: unknown } | null)?.name === "AbortError";
}
