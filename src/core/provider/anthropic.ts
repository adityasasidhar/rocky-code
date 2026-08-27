import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  Tool as SdkTool,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  ContentBlock,
  Provider,
  ProviderRequest,
  StopReason,
  StreamEvent,
  Usage,
} from "../types.ts";
import { emptyUsage } from "../types.ts";

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

/** USD per token. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5": { input: 10e-6, output: 50e-6 },
  "claude-mythos-5": { input: 10e-6, output: 50e-6 },
  "claude-opus-4-8": { input: 5e-6, output: 25e-6 },
  "claude-opus-4-7": { input: 5e-6, output: 25e-6 },
  "claude-opus-4-6": { input: 5e-6, output: 25e-6 },
  "claude-sonnet-5": { input: 3e-6, output: 15e-6 },
  "claude-sonnet-4-6": { input: 3e-6, output: 15e-6 },
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6 },
};

const MAX_MESSAGE_BREAKPOINTS = 3; // + 1 on the system prompt = the API's limit of 4
const BLOCKS_BETWEEN_BREAKPOINTS = 12; // stay inside the 20-block lookback window

// ---------------------------------------------------------------------------
// Adapter boundary: our types <-> SDK types
// ---------------------------------------------------------------------------

function toSdkContent(block: ContentBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      // Round-tripped verbatim. Editing `signature` makes the API reject the turn.
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
  }
}

/**
 * Place cache breakpoints on the trailing message boundaries.
 *
 * A breakpoint only searches back 20 content blocks for a prior cache entry.
 * Agentic turns emit many blocks (thinking + text + N tool_use, then N
 * tool_results), so a single breakpoint at the very end silently stops hitting
 * once a turn grows past that window. Spacing them ~12 blocks apart keeps every
 * request landing inside the previous request's lookback.
 */
export function applyCacheBreakpoints(messages: MessageParam[]): MessageParam[] {
  const marks = new Set<number>();
  let sinceLast = Infinity;

  for (let i = messages.length - 1; i >= 0 && marks.size < MAX_MESSAGE_BREAKPOINTS; i--) {
    const content = messages[i]!.content;
    const blocks = Array.isArray(content) ? content.length : 1;
    if (sinceLast >= BLOCKS_BETWEEN_BREAKPOINTS) {
      marks.add(i);
      sinceLast = 0;
    }
    sinceLast += blocks;
  }

  return messages.map((msg, i) => {
    if (!marks.has(i) || !Array.isArray(msg.content) || msg.content.length === 0) {
      return msg;
    }
    const content = [...msg.content];
    const last = content[content.length - 1]!;
    // cache_control is invalid on thinking blocks.
    if (last.type === "thinking" || last.type === "redacted_thinking") return msg;
    content[content.length - 1] = {
      ...last,
      cache_control: { type: "ephemeral" },
    } as ContentBlockParam;
    return { ...msg, content };
  });
}

function fromSdkMessage(content: readonly unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const raw of content) {
    const b = raw as { type: string } & Record<string, unknown>;
    switch (b.type) {
      case "text":
        out.push({ type: "text", text: b["text"] as string });
        break;
      case "thinking":
        out.push({
          type: "thinking",
          thinking: b["thinking"] as string,
          signature: b["signature"] as string,
        });
        break;
      case "redacted_thinking":
        out.push({ type: "redacted_thinking", data: b["data"] as string });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: b["id"] as string,
          name: b["name"] as string,
          input: b["input"],
        });
        break;
      default:
        // Server-tool blocks we don't use. Ignore rather than crash.
        break;
    }
  }
  return out;
}

function usageOf(u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; baseURL?: string } = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      // Retries 408/409/429/5xx with exponential backoff.
      maxRetries: 5,
      timeout: 10 * 60 * 1000,
    });
  }

  contextWindow(model: string): number {
    return CONTEXT_WINDOWS[model] ?? 200_000;
  }

  pricing(model: string) {
    return PRICING[model] ?? { input: 5e-6, output: 25e-6 };
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const system: TextBlockParam[] = req.system.map((seg, i) => ({
      type: "text",
      text: seg.text,
      ...(seg.cache || i === req.system.length - 1
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    }));

    const messages = applyCacheBreakpoints(
      req.messages.map((m) => ({
        role: m.role,
        content: m.content.map(toSdkContent),
      })),
    );

    const tools: SdkTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as SdkTool["input_schema"],
    }));

    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system,
        messages,
        tools,
        output_config: { effort: req.effort },
        thinking: req.thinking
          ? { type: "adaptive", display: "summarized" }
          : { type: "disabled" },
      },
      { signal: req.signal },
    );

    yield { type: "message_start" };

    /** Text blocks completed before an abort; salvaged so context isn't lost. */
    const partialText: string[] = [];
    let current = "";

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              yield {
                type: "tool_use_start",
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            current = "";
            break;

          case "content_block_delta":
            switch (event.delta.type) {
              case "text_delta":
                current += event.delta.text;
                yield { type: "text_delta", text: event.delta.text };
                break;
              case "thinking_delta":
                yield { type: "thinking_delta", text: event.delta.thinking };
                break;
              case "input_json_delta":
                yield {
                  type: "tool_use_input_delta",
                  id: String(event.index),
                  partialJson: event.delta.partial_json,
                };
                break;
              default:
                break;
            }
            break;

          case "content_block_stop":
            if (current) partialText.push(current);
            current = "";
            yield { type: "block_end" };
            break;

          default:
            break;
        }
      }

      const final = await stream.finalMessage();
      yield {
        type: "message_end",
        message: { role: "assistant", content: fromSdkMessage(final.content) },
        stopReason: (final.stop_reason ?? "end_turn") as StopReason,
        usage: usageOf(final.usage),
      };
    } catch (err) {
      if (isAbort(err, req.signal)) {
        // Salvage completed text only. A dangling tool_use with no tool_result,
        // or a thinking block with no signature, would make the next request 400.
        const text = partialText.join("");
        yield {
          type: "message_end",
          message: {
            role: "assistant",
            content: text ? [{ type: "text", text }] : [],
          },
          stopReason: "aborted",
          usage: emptyUsage(),
        };
        return;
      }
      throw err;
    }
  }
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof Anthropic.APIUserAbortError) return true;
  return err instanceof Error && err.name === "AbortError";
}
