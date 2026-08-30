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
import {
  iterateSSE,
  postStream,
  ToolCallAccumulator,
} from "./stream_util.ts";
import { ThinkTagFilter } from "../think_tag.ts";

// ---------------------------------------------------------------------------
// Wire types (adapter boundary — the only place these shapes exist)
// ---------------------------------------------------------------------------

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type Chunk = {
  choices?: {
    index: number;
    delta?: {
      content?: string | null;
      /** DeepSeek and friends. OpenAI o-series does not stream reasoning. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
};

export type OpenAIProviderOptions = {
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  pricing?: { input: number; output: number };
  /** OpenAI renamed the field; older compatible servers only accept max_tokens. */
  useMaxCompletionTokens?: boolean;
  /** Only valid for reasoning models; a chat model rejects the request. */
  sendReasoningEffort?: boolean;
  headers?: Record<string, string>;
  name?: string;
};

/**
 * Speaks /chat/completions. Works against OpenAI, llama.cpp, vLLM, LM Studio,
 * OpenRouter, and Ollama's compatibility layer.
 *
 * Two capabilities are lost relative to Anthropic and are deliberately not
 * faked: there is no prompt-cache control (OpenAI caches automatically and only
 * reports it), and reasoning cannot be round-tripped, so thinking is streamed
 * for display but never written into the message history.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string;

  constructor(private readonly opts: OpenAIProviderOptions) {
    this.name = opts.name ?? "openai";
  }

  contextWindow(): number {
    return this.opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  pricing() {
    return this.opts.pricing ?? { input: 0, output: 0 };
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const messages: ChatMessage[] = [
      { role: "system", content: req.system.map((s) => s.text).join("\n\n") },
      ...toChatMessages(req.messages),
    ];

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      [this.opts.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"]:
        req.maxTokens,
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
    if (this.opts.sendReasoningEffort && req.thinking) {
      body["reasoning_effort"] = mapEffort(req.effort);
    }

    const headers: Record<string, string> = { ...this.opts.headers };
    if (this.opts.apiKey) headers["Authorization"] = `Bearer ${this.opts.apiKey}`;

    yield { type: "message_start" };

    // The fetch itself can reject on abort: a server may withhold response
    // headers until its first chunk, so this must be inside the guard too.
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await postStream(
        `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
        body,
        headers,
        req.signal,
      );
    } catch (err) {
      if (isAbort(err, req.signal)) {
        yield abortedEnd("");
        return;
      }
      throw err;
    }

    const tools = new ToolCallAccumulator();
    const announced = new Set<number>();
    const thinkFilter = new ThinkTagFilter();
    let text = "";
    let finish: string | null = null;
    let usage: Usage = emptyUsage();

    try {
      for await (const chunk of iterateSSE<Chunk>(stream)) {
        if (chunk.usage) usage = usageOf(chunk.usage);

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "thinking_delta", text: reasoning };

        if (delta.content) {
          text += delta.content;
          for (const segment of thinkFilter.push(delta.content)) {
            yield {
              type: segment.kind === "thinking" ? "thinking_delta" : "text_delta",
              text: segment.text,
            };
          }
        }

        for (const call of delta.tool_calls ?? []) {
          const first = !tools.has(call.index);
          tools.add(call.index, {
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { name: call.function.name } : {}),
            ...(call.function?.arguments ? { args: call.function.arguments } : {}),
          });
          // Announce once, as soon as we know the name.
          if (first && call.function?.name && !announced.has(call.index)) {
            announced.add(call.index);
            yield {
              type: "tool_use_start",
              id: call.id ?? `call_${call.index}_${call.function.name}`,
              name: call.function.name,
            };
          }
          if (call.function?.arguments) {
            yield {
              type: "tool_use_input_delta",
              id: String(call.index),
              partialJson: call.function.arguments,
            };
          }
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

    for (const segment of thinkFilter.flush()) {
      yield {
        type: segment.kind === "thinking" ? "thinking_delta" : "text_delta",
        text: segment.text,
      };
    }

    const calls = tools.finish();
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const c of calls) {
      content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }

    yield {
      type: "message_end",
      message: { role: "assistant", content },
      // Some servers omit finish_reason:"tool_calls" but still emit calls.
      stopReason: calls.length > 0 ? "tool_use" : mapFinish(finish),
      usage,
    };
  }
}

// ---------------------------------------------------------------------------

/** Thinking blocks are dropped: no provider here can round-trip a signature. */
export function toChatMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const msg of messages) {
    const results = msg.content.filter((b) => b.type === "tool_result");
    if (results.length > 0) {
      // Each tool_result becomes its own `tool` message.
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
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
    const text = textOf(msg.content);
    if (calls.length === 0) {
      if (text) out.push({ role: "assistant", content: text });
      continue;
    }
    out.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })),
    });
  }
  return out;
}

const textOf = (content: ContentBlock[]): string =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

export function mapFinish(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** OpenAI has three effort levels; collapse ours onto them. */
export function mapEffort(effort: string): string {
  switch (effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
}

/**
 * OpenAI's `prompt_tokens` *includes* cached tokens; Anthropic's `input_tokens`
 * excludes them. Subtract so `promptTokens()` stays a true total either way.
 */
function usageOf(u: NonNullable<Chunk["usage"]>): Usage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  };
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
