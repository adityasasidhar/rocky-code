import type {
  ContentBlock,
  Provider,
  ProviderRequest,
  StopReason,
  StreamEvent,
  Usage,
} from "../src/core/types.ts";
import { emptyUsage } from "../src/core/types.ts";

export type ScriptedTurn = {
  content: ContentBlock[];
  stopReason: StopReason;
  usage?: Partial<Usage>;
};

/**
 * Replays recorded responses. Records the requests it received so tests can
 * assert on message structure — particularly tool_use/tool_result pairing.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly requests: ProviderRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly opts: { onStream?: () => void | Promise<void> } = {},
  ) {}

  contextWindow(): number {
    return 200_000;
  }

  pricing() {
    return { input: 1e-6, output: 2e-6 };
  }

  get callCount(): number {
    return this.index;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined> {
    // Snapshot: the loop mutates session.messages between calls.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });

    const turn = this.script[this.index++];
    if (!turn) throw new Error(`MockProvider: no scripted turn #${this.index}`);

    yield { type: "message_start" };
    await this.opts.onStream?.();

    if (req.signal.aborted) {
      yield {
        type: "message_end",
        message: { role: "assistant", content: [] },
        stopReason: "aborted",
        usage: emptyUsage(),
      };
      return;
    }

    for (const block of turn.content) {
      if (block.type === "text") yield { type: "text_delta", text: block.text };
      if (block.type === "thinking") yield { type: "thinking_delta", text: block.thinking };
      if (block.type === "tool_use") {
        yield { type: "tool_use_start", id: block.id, name: block.name };
      }
      yield { type: "block_end" };
    }

    yield {
      type: "message_end",
      message: { role: "assistant", content: turn.content },
      stopReason: turn.stopReason,
      usage: { ...emptyUsage(), ...turn.usage },
    };
  }
}

export const text = (t: string): ContentBlock => ({ type: "text", text: t });

export const thinking = (t: string): ContentBlock => ({
  type: "thinking",
  thinking: t,
  signature: "sig",
});

export const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
