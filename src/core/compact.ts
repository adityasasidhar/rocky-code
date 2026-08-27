import type { Session } from "./session.ts";
import { truncateMiddle } from "./truncate.ts";
import type { ContentBlock, Message, Provider, Usage } from "./types.ts";
import { emptyUsage } from "./types.ts";

/**
 * Auto-compaction.
 *
 * When the prompt approaches the model's context window, summarize the *middle*
 * of the conversation and rebuild it as: system prompt + recap + the last N
 * turns verbatim.
 *
 * Two invariants make this safe rather than merely clever:
 *
 *  1. **Never split a tool_use from its tool_result.** A kept tail that starts
 *     with an orphaned tool_result is a 400 from the API; a dropped tool_result
 *     whose tool_use survives is the same. The cut may therefore only land on a
 *     plain user message — one that begins a fresh exchange.
 *
 *  2. **Never summarize the in-flight task's most recent work.** The tail is
 *     kept byte-for-byte, so the tool results the model is currently reasoning
 *     about survive untouched. Compaction is for what came before.
 */

const RECAP_SYSTEM = `You are compacting a coding agent's conversation so it can continue
working with a smaller context window. The agent will see ONLY your summary plus its most
recent turns — everything else is discarded.

Write a factual, dense recap under exactly these headings:

## Task
What the user asked for, in their terms. Include constraints they stated.

## State
What is done, what is in progress, what is verified vs. merely attempted.

## Files
Every file read or modified, with a one-line note on what changed or what it contains.
Use exact paths.

## Decisions
Choices made and why, including approaches tried and rejected. The agent must not
re-litigate these or repeat failed attempts.

## Facts
Specific values the agent will need again: commands that work, test names, error
messages, function signatures, line numbers.

## TODO
What remains, as an ordered list. Empty if nothing remains.

Rules:
- Preserve exact identifiers, paths, and commands. Do not paraphrase them.
- Omit conversational filler entirely. No preamble, no sign-off.
- If something was never established, do not invent it.`;

export type CompactionOptions = {
  /** How many trailing user-turn boundaries to keep verbatim, when there are any. */
  keepTurns?: number;
  /**
   * Fallback for a single-prompt agentic run, which has no user boundaries to
   * cut on: keep at least this many trailing messages.
   */
  keepMessages?: number;
  /**
   * Token budget (estimated) for the kept tail. Message counts lie — six
   * messages can be six lines or six 30KB tool results — so when this is set
   * it, not the count, decides where the cut lands. `compactSession` defaults
   * it to 20% of the model's context window.
   */
  keepTokens?: number;
  /** Never compact unless at least this many messages would be dropped. */
  minDropped?: number;
  /** Max tokens for the recap itself. */
  maxRecapTokens?: number;
  /** Chars of each tool result to show the summarizer. */
  blockChars?: number;
};

export type Compaction = {
  messages: Message[];
  recap: string;
  droppedMessages: number;
  usage: Usage;
};

/**
 * Cheap token estimate: utf8 bytes / 4. This drives a cut heuristic, not
 * billing — being 20% off moves a cut point by a message or two, which is
 * exactly as much precision as the decision deserves.
 */
export function estimateMessageTokens(message: Message): number {
  let bytes = 0;
  for (const b of message.content) {
    switch (b.type) {
      case "text":
        bytes += Buffer.byteLength(b.text, "utf8");
        break;
      case "thinking":
        bytes += Buffer.byteLength(b.thinking, "utf8");
        break;
      case "redacted_thinking":
        bytes += Buffer.byteLength(b.data, "utf8");
        break;
      case "tool_use":
        bytes += Buffer.byteLength(JSON.stringify(b.input ?? {}), "utf8");
        break;
      case "tool_result":
        bytes += Buffer.byteLength(b.content, "utf8");
        break;
    }
  }
  return Math.ceil(bytes / 4);
}

/** A message that starts a fresh exchange: user text, no tool results. */
export function isPlainUserTurn(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every((b) => b.type === "text")
  );
}

/**
 * A cut at index `i` keeps `messages[i..]` and drops the rest.
 *
 * It is safe exactly when `messages[i]` carries no tool_result: a tool_result's
 * matching tool_use always lives in the message immediately before it, so any
 * result kept at `j > i` has its call kept too. Cutting *onto* a tool_result is
 * the one thing that orphans a block and earns a 400 from the API.
 */
export function isSafeCut(messages: Message[], i: number): boolean {
  const message = messages[i];
  if (!message) return false;
  return !message.content.some((b) => b.type === "tool_result");
}

/**
 * The index at which the kept tail begins.
 *
 * Two policies, in order:
 *
 *  1. Cut at a plain user turn, keeping `keepTurns` of them. This produces the
 *     cleanest recap — whole exchanges in, whole exchanges out.
 *  2. If there aren't that many user turns — the shape of every `rocky -p`
 *     run, one prompt followed by fifty tool calls — keep a tail sized by
 *     `keepTokens` (estimated), falling back to the last `keepMessages`
 *     messages, snapped forward to the nearest safe index. Without this,
 *     compaction could never fire on exactly the runs that need it most.
 *
 * The policies do not chain, with one amendment: a policy-1 cut whose kept
 * tail is *over the token budget* falls through to policy 2. The original
 * rule protected short conversations from the aggressive policy; keeping the
 * promise when the tail alone still crowds the window would defeat the whole
 * point of compacting.
 */
export function findCutIndex(
  messages: Message[],
  opts: CompactionOptions = {},
): number | undefined {
  const keepTurns = opts.keepTurns ?? 2;
  const keepMessages = opts.keepMessages ?? 6;
  const keepTokens = opts.keepTokens;
  const minDropped = opts.minDropped ?? 2;

  // suffix[i] = estimated tokens of messages[i..]; computed only when budgeted.
  const suffix: number[] = [];
  if (keepTokens !== undefined) {
    let sum = 0;
    suffix.length = messages.length + 1;
    suffix[messages.length] = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      sum += estimateMessageTokens(messages[i]!);
      suffix[i] = sum;
    }
  }
  const withinBudget = (cut: number): boolean =>
    keepTokens === undefined || suffix[cut]! <= keepTokens;

  // `cut` doubles as the number of messages dropped.
  const viable = (cut: number | undefined): number | undefined =>
    cut !== undefined && cut >= minDropped && isSafeCut(messages, cut) ? cut : undefined;

  // Policy 1: plain user boundaries, newest first.
  if (keepTurns >= 1) {
    const boundaries: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isPlainUserTurn(messages[i]!)) boundaries.push(i);
      if (boundaries.length > keepTurns) break;
    }
    if (boundaries.length >= keepTurns) {
      const cut = viable(boundaries[keepTurns - 1]);
      // There are enough boundaries, so this policy owns the decision. If its
      // cut is too small the conversation is simply short — do not fall through
      // to the aggressive policy and drop turns we promised to keep. Only a
      // tail too fat for the budget falls through.
      if (cut === undefined) return undefined;
      if (withinBudget(cut)) return cut;
    }
  }

  // Policy 2: keep a tail that fits the budget when one is set, otherwise the
  // last N messages; snap the cut forward to the nearest safe index.
  let start = Math.max(0, messages.length - keepMessages);
  if (keepTokens !== undefined) {
    start = messages.length;
    for (let i = 0; i < messages.length; i++) {
      if (suffix[i]! <= keepTokens) {
        start = i;
        break;
      }
    }
  }
  for (let i = start; i < messages.length; i++) {
    const cut = viable(i);
    if (cut !== undefined) return cut;
  }
  return undefined;
}

/** Render messages as text for the summarizer. Tool payloads are heavily clipped. */
export function renderTranscript(messages: Message[], blockChars = 800): string {
  const out: string[] = [];
  for (const message of messages) {
    const parts = message.content.map((b) => renderBlock(b, blockChars)).filter(Boolean);
    if (parts.length) out.push(`<${message.role}>\n${parts.join("\n")}\n</${message.role}>`);
  }
  return out.join("\n\n");
}

function renderBlock(block: ContentBlock, chars: number): string {
  switch (block.type) {
    case "text":
      return block.text.trim();
    case "tool_use":
      return `[called ${block.name} with ${clip(JSON.stringify(block.input ?? {}), chars)}]`;
    case "tool_result":
      return `[${block.is_error ? "tool error" : "tool result"}: ${clip(block.content, chars)}]`;
    case "thinking":
    case "redacted_thinking":
      // Reasoning is not re-summarizable and cannot be replayed. Drop it.
      return "";
  }
}

const clip = (s: string, n: number) =>
  Buffer.byteLength(s, "utf8") <= n ? s : truncateMiddle(s, n).text;

/**
 * Summarize `messages[0..cut)` and return the rebuilt message list.
 * Returns undefined when there is no safe cut point.
 */
export async function compactMessages(
  provider: Provider,
  model: string,
  messages: Message[],
  signal: AbortSignal,
  opts: CompactionOptions = {},
): Promise<Compaction | undefined> {
  const cut = findCutIndex(messages, opts);
  if (cut === undefined) return undefined;

  const head = messages.slice(0, cut);
  const tail = messages.slice(cut);

  let recap = "";
  let usage: Usage = emptyUsage();

  for await (const event of provider.stream({
    model,
    system: [{ text: RECAP_SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Compact this conversation:\n\n${renderTranscript(head, opts.blockChars)}`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: opts.maxRecapTokens ?? 4000,
    effort: "low",
    // A summary does not need reasoning, and thinking blocks would be discarded.
    thinking: false,
    signal,
  })) {
    if (event.type === "text_delta") recap += event.text;
    if (event.type === "message_end") {
      usage = event.usage;
      if (event.stopReason === "aborted") return undefined;
    }
  }

  recap = recap.trim();
  if (!recap) return undefined;

  return {
    messages: [recapMessage(recap), ...tail],
    recap,
    droppedMessages: head.length,
    usage,
  };
}

/**
 * The recap enters as a user turn. It is tagged so the model treats it as
 * transcript, not as something the user just said.
 */
export function recapMessage(recap: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "The earlier part of this conversation was summarized to free context. " +
          "Continue from this state; do not repeat completed work.\n\n" +
          `<conversation_summary>\n${recap}\n</conversation_summary>`,
      },
    ],
  };
}

export type CompactOutcome =
  | { ok: true; recap: string; droppedMessages: number; before: number; after: number }
  | { ok: false; reason: string };

/**
 * Compact a session in place. Safe to call when nothing needs compacting; it
 * reports why it declined rather than mutating anything.
 */
export async function compactSession(
  session: Session,
  signal: AbortSignal,
  opts: CompactionOptions = {},
): Promise<CompactOutcome> {
  const before = session.messages.length;

  const result = await compactMessages(
    session.provider,
    session.model,
    session.messages,
    signal,
    // The budget follows the model actually in use: keep ~20% of its window.
    { keepTokens: Math.floor(session.contextWindow * 0.2), ...opts },
  );
  if (!result) {
    return {
      ok: false,
      reason: "not enough conversation to compact yet",
    };
  }

  session.messages = result.messages;
  session.recordUsage(result.usage);
  session.compactions++;
  // The next request's prompt is much smaller; the meter must not keep
  // reporting the pre-compaction size until a turn happens to update it.
  session.resetContextMeter();

  return {
    ok: true,
    recap: result.recap,
    droppedMessages: result.droppedMessages,
    before,
    after: result.messages.length,
  };
}
