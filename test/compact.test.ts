import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config/schema.ts";
import {
  compactMessages,
  compactSession,
  estimateMessageTokens,
  findCutIndex,
  isPlainUserTurn,
  isSafeCut,
  recapMessage,
  renderTranscript,
} from "../src/core/compact.ts";
import { Session } from "../src/core/session.ts";
import type { Message } from "../src/core/types.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider, text, type ScriptedTurn } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const user = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
const assistant = (t: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
});
const toolCall = (id: string, name = "bash"): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: { command: "ls" } }],
});
const toolResult = (id: string, content = "out"): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
});

/** Every tool_use has a matching tool_result, and vice versa. */
function pairsIntact(messages: Message[]): boolean {
  const uses = new Set(
    messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id)),
  );
  const results = new Set(
    messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id),
    ),
  );
  if (uses.size !== results.size) return false;
  for (const id of results) if (!uses.has(id)) return false;
  return true;
}

describe("isPlainUserTurn", () => {
  test("a text-only user message starts a fresh exchange", () => {
    expect(isPlainUserTurn(user("hi"))).toBe(true);
  });

  test("a tool_result message does not", () => {
    expect(isPlainUserTurn(toolResult("t1"))).toBe(false);
  });

  test("an assistant message does not", () => {
    expect(isPlainUserTurn(assistant("hi"))).toBe(false);
  });

  test("an empty message does not", () => {
    expect(isPlainUserTurn({ role: "user", content: [] })).toBe(false);
  });
});

describe("findCutIndex", () => {
  test("cuts at a plain user turn, keeping the requested number of them", () => {
    const messages = [user("a"), assistant("1"), user("b"), assistant("2"), user("c")];
    // keepTurns 2 -> keep from "b" onward.
    expect(findCutIndex(messages, { keepTurns: 2 })).toBe(2);
  });

  test("never cuts between a tool_use and its tool_result", () => {
    const messages = [
      user("a"),
      toolCall("t1"),
      toolResult("t1"),
      assistant("done"),
      user("b"),
      toolCall("t2"),
      toolResult("t2"),
      assistant("done"),
      user("c"),
    ];
    const cut = findCutIndex(messages, { keepTurns: 2 })!;
    expect(cut).toBe(4); // the "b" user turn

    // The dropped head and the kept tail are each internally consistent.
    expect(pairsIntact(messages.slice(0, cut))).toBe(true);
    expect(pairsIntact(messages.slice(cut))).toBe(true);
  });

  test("a short conversation is left alone rather than compacted aggressively", () => {
    // Enough boundaries exist, so the user-turn policy decides — and it
    // declines. Falling through to the fallback would drop turns we promised.
    expect(findCutIndex([user("a"), user("b"), user("c")], { keepTurns: 2 })).toBeUndefined();
    expect(findCutIndex([user("a"), assistant("1")], { keepTurns: 2 })).toBeUndefined();
    expect(findCutIndex([user("a"), assistant("1"), user("b")], { keepTurns: 2 })).toBeUndefined();
  });

  test("never cuts at index 0, which would drop nothing but still cost a call", () => {
    expect(findCutIndex([user("a")], { keepTurns: 0 })).toBeUndefined();
    expect(findCutIndex([user("a"), user("b")], { keepTurns: 1, minDropped: 1 })).toBe(1);
  });

  test("minDropped stops a compaction that would not be worth the call", () => {
    const messages = [user("a"), assistant("1"), user("b"), assistant("2"), user("c")];
    expect(findCutIndex(messages, { keepTurns: 2, minDropped: 5 })).toBeUndefined();
  });

  describe("token budget (keepTokens)", () => {
    // ~30k bytes ≈ 7.5k estimated tokens per fat result.
    const fat = (id: string) => toolResult(id, "x".repeat(30_000));

    test("fat and thin tails cut differently under the same budget", () => {
      const thin = [
        user("go"),
        ...[1, 2, 3, 4].flatMap((n) => [toolCall(`t${n}`), toolResult(`t${n}`)]),
      ];
      const heavy = [
        user("go"),
        ...[1, 2, 3, 4].flatMap((n) => [toolCall(`t${n}`), fat(`t${n}`)]),
      ];
      // Nine messages each. Thin fits the budget almost whole; heavy must
      // shed most of itself to fit.
      const thinCut = findCutIndex(thin, { keepTokens: 8_000, minDropped: 1 })!;
      const heavyCut = findCutIndex(heavy, { keepTokens: 8_000, minDropped: 1 })!;
      expect(thinCut).toBeLessThan(heavyCut);
      // The heavy tail actually fits the budget now (one fat pair ≈ 7.5k).
      const kept = heavy.slice(heavyCut);
      const keptTokens = kept.reduce((n, m) => n + estimateMessageTokens(m), 0);
      expect(keptTokens).toBeLessThanOrEqual(8_000);
      // And the cut is still safe.
      expect(pairsIntact(heavy.slice(0, heavyCut))).toBe(true);
      expect(pairsIntact(kept)).toBe(true);
    });

    test("a user-turn cut over budget falls through to the token policy", () => {
      const messages = [
        user("first task"),
        assistant("done"),
        user("second task"), // policy 1 would cut here (keepTurns 2)…
        toolCall("t1"),
        fat("t1"), // …but the kept tail would be ~7.5k tokens
        assistant("working"),
        user("third task"),
        assistant("ok"),
      ];
      const strict = findCutIndex(messages, { keepTurns: 2, keepTokens: 2_000 })!;
      // Policy 1 wanted index 2; the budget pushed the cut past the fat result.
      expect(strict).toBeGreaterThan(4);
      expect(pairsIntact(messages.slice(strict))).toBe(true);

      // With room in the budget, policy 1's promise stands exactly as before.
      expect(findCutIndex(messages, { keepTurns: 2, keepTokens: 50_000 })).toBe(2);
    });

    test("no budget reproduces the old behavior byte-for-byte", () => {
      const messages = [user("a"), assistant("1"), user("b"), assistant("2"), user("c")];
      expect(findCutIndex(messages, { keepTurns: 2 })).toBe(
        findCutIndex(messages, { keepTurns: 2, keepTokens: undefined }),
      );
    });

    test("estimateMessageTokens counts every block kind", () => {
      const m: Message = {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(400) },
          { type: "thinking", thinking: "b".repeat(400), signature: "sig" },
          { type: "redacted_thinking", data: "c".repeat(400) },
          // {"command":"…"} wraps the payload in 14 bytes → 386 + 14 = 400.
          { type: "tool_use", id: "t", name: "bash", input: { command: "d".repeat(386) } },
          { type: "tool_result", tool_use_id: "t", content: "e".repeat(400), is_error: false },
        ],
      };
      // Five blocks × 400 bytes = 2000 bytes → 500 estimated tokens.
      expect(estimateMessageTokens(m)).toBe(500);
      expect(estimateMessageTokens(user(""))).toBe(0);
    });
  });

  // The `rocky -p` shape: one prompt, then a long run of tool calls. Without a
  // fallback, compaction could never fire on exactly the runs that need it.
  describe("single-prompt agentic runs (no user boundaries)", () => {
    const agentic = () => [
      user("fix the bug"),
      toolCall("t1"),
      toolResult("t1"),
      toolCall("t2"),
      toolResult("t2"),
      toolCall("t3"),
      toolResult("t3"),
      toolCall("t4"),
      toolResult("t4"),
      assistant("done"),
    ];

    test("falls back to keeping the last N messages", () => {
      const messages = agentic();
      const cut = findCutIndex(messages, { keepTurns: 2, keepMessages: 6 })!;
      expect(cut).toBeGreaterThan(0);
      expect(messages.length - cut).toBeLessThanOrEqual(6);
    });

    test("snaps the cut forward off a tool_result, never orphaning a call", () => {
      const messages = agentic();
      // messages[4] is a tool_result; the cut must not land there.
      expect(isSafeCut(messages, 4)).toBe(false);
      const cut = findCutIndex(messages, { keepTurns: 2, keepMessages: 6 })!;
      expect(isSafeCut(messages, cut)).toBe(true);
      expect(pairsIntact(messages.slice(0, cut))).toBe(true);
      expect(pairsIntact(messages.slice(cut))).toBe(true);
    });

    test("a short tool-call run still compacts, keeping the last exchange", () => {
      const messages = [user("a"), toolCall("t1"), toolResult("t1"), toolCall("t2"), toolResult("t2")];
      const cut = findCutIndex(messages, { keepTurns: 2 })!;
      expect(cut).toBe(3);
      expect(pairsIntact(messages.slice(cut))).toBe(true);
    });

    test("nothing to keep means nothing to cut", () => {
      expect(findCutIndex([user("a"), toolCall("t1"), toolResult("t1")], {})).toBeUndefined();
    });
  });
});

describe("isSafeCut", () => {
  test("a tool_result is never a safe cut point", () => {
    const messages = [toolCall("t1"), toolResult("t1")];
    expect(isSafeCut(messages, 1)).toBe(false);
  });

  test("an assistant tool_use is safe: its result comes after", () => {
    const messages = [toolCall("t1"), toolResult("t1")];
    expect(isSafeCut(messages, 0)).toBe(true);
  });

  test("a plain user turn is safe", () => {
    expect(isSafeCut([user("a")], 0)).toBe(true);
  });

  test("an out-of-range index is not safe", () => {
    expect(isSafeCut([user("a")], 9)).toBe(false);
  });
});

describe("renderTranscript", () => {
  test("labels roles and renders tool calls and results", () => {
    const out = renderTranscript([user("fix it"), toolCall("t1"), toolResult("t1", "ok")]);
    expect(out).toContain("<user>");
    expect(out).toContain("fix it");
    expect(out).toContain("[called bash with");
    expect(out).toContain("[tool result: ok]");
  });

  test("marks tool errors as errors", () => {
    const errored: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }],
    };
    expect(renderTranscript([errored])).toContain("[tool error: boom]");
  });

  test("clips oversized tool results", () => {
    const big = toolResult("t1", "x".repeat(5000));
    const out = renderTranscript([big], 200);
    expect(out).toContain("bytes elided");
    expect(out.length).toBeLessThan(1000);
  });

  test("drops thinking blocks — they cannot be replayed or re-summarized", () => {
    const withThinking: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret reasoning", signature: "sig" },
        { type: "text", text: "visible" },
      ],
    };
    const out = renderTranscript([withThinking]);
    expect(out).not.toContain("secret reasoning");
    expect(out).toContain("visible");
  });
});

describe("recapMessage", () => {
  test("is a user turn, tagged so the model reads it as transcript", () => {
    const m = recapMessage("## Task\nfix bug");
    expect(m.role).toBe("user");
    expect(isPlainUserTurn(m)).toBe(true);
    const body = m.content[0]!;
    expect(body.type === "text" && body.text).toContain("<conversation_summary>");
    expect(body.type === "text" && body.text).toContain("do not repeat completed work");
  });
});

describe("compactMessages", () => {
  const history = (): Message[] => [
    user("first task"),
    toolCall("t1"),
    toolResult("t1"),
    assistant("did the first thing"),
    user("second task"),
    toolCall("t2"),
    toolResult("t2"),
    assistant("did the second thing"),
    user("third task"),
    assistant("working"),
  ];

  const summarizer = () =>
    new MockProvider([{ content: [text("## Task\nfix things")], stopReason: "end_turn" }]);

  test("rebuilds as recap + verbatim tail", async () => {
    const provider = summarizer();
    const result = (await compactMessages(
      provider,
      "m",
      history(),
      new AbortController().signal,
      { keepTurns: 2 },
    ))!;

    expect(result.droppedMessages).toBe(4);
    expect(result.recap).toContain("fix things");

    // recap, then the last two exchanges byte-for-byte.
    expect(result.messages[0]!.role).toBe("user");
    expect(isPlainUserTurn(result.messages[0]!)).toBe(true);
    expect(result.messages.slice(1)).toEqual(history().slice(4));
  });

  test("the rebuilt transcript has no orphaned tool_result", async () => {
    const result = (await compactMessages(
      summarizer(),
      "m",
      history(),
      new AbortController().signal,
      { keepTurns: 2 },
    ))!;
    expect(pairsIntact(result.messages)).toBe(true);
  });

  test("the in-flight tail is never summarized", async () => {
    const messages = history();
    const result = (await compactMessages(
      summarizer(),
      "m",
      messages,
      new AbortController().signal,
      { keepTurns: 1 },
    ))!;
    // The most recent exchange survives untouched.
    expect(result.messages.at(-1)).toEqual(messages.at(-1)!);
    expect(result.messages.at(-2)).toEqual(messages.at(-2)!);
  });

  test("summarization runs without tools and without thinking", async () => {
    const provider = summarizer();
    await compactMessages(provider, "m", history(), new AbortController().signal, {
      keepTurns: 2,
    });

    const request = provider.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.thinking).toBe(false);
    expect(request.effort).toBe("low");
    // The summarizer sees only the head.
    const sent = request.messages[0]!.content[0]!;
    expect(sent.type === "text" && sent.text).toContain("first task");
    expect(sent.type === "text" && sent.text).not.toContain("third task");
  });

  test("returns undefined when there is no safe cut", async () => {
    const provider = summarizer();
    const result = await compactMessages(
      provider,
      "m",
      [user("only")],
      new AbortController().signal,
    );
    expect(result).toBeUndefined();
    // No pointless summarization call was made.
    expect(provider.callCount).toBe(0);
  });

  test("an aborted summarization changes nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await compactMessages(summarizer(), "m", history(), ac.signal, {
      keepTurns: 2,
    });
    expect(result).toBeUndefined();
  });

  test("an empty recap is treated as failure, not as a valid summary", async () => {
    const provider = new MockProvider([{ content: [text("   ")], stopReason: "end_turn" }]);
    const result = await compactMessages(provider, "m", history(), new AbortController().signal, {
      keepTurns: 2,
    });
    expect(result).toBeUndefined();
  });
});

describe("compactSession", () => {
  const build = (script: ScriptedTurn[] = []) => {
    const provider = new MockProvider(
      script.length
        ? script
        : [{ content: [text("## Task\nrecap")], stopReason: "end_turn" }],
    );
    const session = new Session({ cwd: dir, config: defaultConfig(), provider, projectDir: dir });
    session.messages = [
      user("a"),
      assistant("1"),
      user("b"),
      assistant("2"),
      user("c"),
      assistant("3"),
    ];
    return { session, provider };
  };

  test("replaces the history and reports what it dropped", async () => {
    const { session } = build();
    const outcome = await compactSession(session, new AbortController().signal, {
      keepTurns: 2,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.before).toBe(6);
    expect(outcome.after).toBe(5);
    expect(outcome.droppedMessages).toBe(2);
    expect(session.messages).toHaveLength(5);
    expect(session.compactions).toBe(1);
  });

  test("resets the context meter, so it does not immediately re-trigger", async () => {
    const { session } = build();
    session.recordUsage({
      inputTokens: 190_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(session.needsCompaction).toBe(true);

    await compactSession(session, new AbortController().signal, { keepTurns: 2 });
    expect(session.needsCompaction).toBe(false);
  });

  test("bills the summarization call to the session", async () => {
    const { session } = build([
      {
        content: [text("recap")],
        stopReason: "end_turn",
        usage: { inputTokens: 500, outputTokens: 100 },
      },
    ]);
    await compactSession(session, new AbortController().signal, { keepTurns: 2 });
    expect(session.totalUsage.inputTokens).toBe(500);
    expect(session.totalUsage.outputTokens).toBe(100);
  });

  test("declines gracefully, leaving the session untouched", async () => {
    const { session, provider } = build();
    session.messages = [user("only one turn")];

    const outcome = await compactSession(session, new AbortController().signal);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("not enough conversation");
    expect(session.messages).toHaveLength(1);
    expect(session.compactions).toBe(0);
    expect(provider.callCount).toBe(0);
  });
});
