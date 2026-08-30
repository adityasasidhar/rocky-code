import { describe, expect, test } from "bun:test";
import { ThinkTagFilter, type ThinkSegment } from "../../src/backend/trueforge.ts";

/** Feed `chunks` through one filter, as a stream would arrive. */
function stream(...chunks: string[]): ThinkSegment[] {
  const filter = new ThinkTagFilter();
  const out = chunks.flatMap((chunk) => filter.push(chunk));
  return [...out, ...filter.flush()];
}

const visible = (segments: ThinkSegment[]) =>
  segments
    .filter((s) => s.kind === "text")
    .map((s) => s.text)
    .join("");

const reasoning = (segments: ThinkSegment[]) =>
  segments
    .filter((s) => s.kind === "thinking")
    .map((s) => s.text)
    .join("");

describe("ThinkTagFilter", () => {
  test("passes plain content through untouched", () => {
    const segments = stream("READY");
    expect(visible(segments)).toBe("READY");
    expect(reasoning(segments)).toBe("");
  });

  test("splits a complete think span out of one chunk", () => {
    const segments = stream("<think>weighing it</think>\n\nREADY");
    expect(reasoning(segments)).toBe("weighing it");
    expect(visible(segments)).toBe("\n\nREADY");
  });

  // The reason this needs a stateful filter at all: TrueForge streams deltas
  // that cut tags in half, so a chunk boundary must not leak "</thi" as text.
  test("reassembles a tag split across chunk boundaries", () => {
    const segments = stream("<thi", "nk>weigh", "ing it</th", "ink>READY");
    expect(reasoning(segments)).toBe("weighing it");
    expect(visible(segments)).toBe("READY");
  });

  test("splits when every character arrives separately", () => {
    const segments = stream(...[..."<think>hmm</think>done"]);
    expect(reasoning(segments)).toBe("hmm");
    expect(visible(segments)).toBe("done");
  });

  test("streams text without waiting when no tag can follow", () => {
    const filter = new ThinkTagFilter();
    // "READY" cannot begin a tag, so it must not be held back for the next chunk.
    expect(filter.push("READY")).toEqual([{ kind: "text", text: "READY" }]);
  });

  test("treats an unterminated think span as reasoning, not as the answer", () => {
    const segments = stream("<think>still going");
    expect(reasoning(segments)).toBe("still going");
    expect(visible(segments)).toBe("");
  });

  // A stray "<" mid-sentence is ordinary text and has to survive the flush.
  test("releases a partial tag that never completes", () => {
    const segments = stream("a < b", " and c");
    expect(visible(segments)).toBe("a < b and c");
    expect(reasoning(segments)).toBe("");
  });

  test("handles several think spans in one message", () => {
    const segments = stream("<think>one</think>A<think>two</think>B");
    expect(reasoning(segments)).toBe("onetwo");
    expect(visible(segments)).toBe("AB");
  });

  test("keeps text that merely looks like the start of a tag", () => {
    const segments = stream("<thought>kept</thought>");
    expect(visible(segments)).toBe("<thought>kept</thought>");
    expect(reasoning(segments)).toBe("");
  });
});
