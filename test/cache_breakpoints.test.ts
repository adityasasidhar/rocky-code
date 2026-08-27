import { describe, expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { applyCacheBreakpoints } from "../src/core/provider/anthropic.ts";

const textMsg = (role: "user" | "assistant", n: number): MessageParam => ({
  role,
  content: Array.from({ length: n }, (_, i) => ({ type: "text", text: `b${i}` })),
});

const marked = (messages: MessageParam[]): number[] =>
  messages.flatMap((m, i) => {
    if (!Array.isArray(m.content)) return [];
    const last = m.content[m.content.length - 1];
    return last && "cache_control" in last && last.cache_control ? [i] : [];
  });

describe("applyCacheBreakpoints", () => {
  test("marks the final message", () => {
    const out = applyCacheBreakpoints([textMsg("user", 1), textMsg("assistant", 1)]);
    expect(marked(out)).toContain(1);
  });

  test("never exceeds three message breakpoints (system takes the fourth)", () => {
    const messages = Array.from({ length: 40 }, () => textMsg("user", 5));
    expect(marked(applyCacheBreakpoints(messages)).length).toBeLessThanOrEqual(3);
  });

  test("spaces breakpoints so each stays inside the 20-block lookback", () => {
    // 10 messages x 5 blocks = 50 blocks.
    const messages = Array.from({ length: 10 }, () => textMsg("user", 5));
    const idx = marked(applyCacheBreakpoints(messages)).sort((a, b) => a - b);

    expect(idx.length).toBe(3);
    for (let i = 1; i < idx.length; i++) {
      const blocksBetween = (idx[i]! - idx[i - 1]!) * 5;
      expect(blocksBetween).toBeLessThan(20);
    }
  });

  test("a single fat message still gets exactly one breakpoint", () => {
    const out = applyCacheBreakpoints([textMsg("user", 30)]);
    expect(marked(out)).toEqual([0]);
  });

  test("does not put cache_control on a thinking block", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
      },
    ];
    const out = applyCacheBreakpoints(messages);
    expect(marked(out)).toEqual([]);
  });

  test("leaves the original messages untouched", () => {
    const messages = [textMsg("user", 2)];
    const snapshot = structuredClone(messages);
    applyCacheBreakpoints(messages);
    expect(messages).toEqual(snapshot);
  });

  test("tolerates string content", () => {
    const messages: MessageParam[] = [{ role: "user", content: "plain" }];
    expect(() => applyCacheBreakpoints(messages)).not.toThrow();
  });
});
