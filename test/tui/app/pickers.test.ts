import { describe, expect, test } from "bun:test";
import {
  MatchRank,
  filterItems,
  matches,
  rank,
  windowFor,
  PICKER_VISIBLE_ROWS,
} from "../../../src/tui/app/pickers.tsx";
import type { PickerItem } from "../../../src/tui/app/store.ts";

const item = (label: string, extra: Partial<PickerItem> = {}): PickerItem => ({
  value: label.toLowerCase().replace(/\s+/g, "-"),
  label,
  ...extra,
});

const PROVIDERS = [
  item("MiniMax (minimax.io)"),
  item("MiniMax Coding Plan"),
  item("OpenAI"),
  item("OpenRouter"),
  item("Amazon Bedrock", { disabled: true, disabledReason: "needs @ai-sdk/amazon-bedrock" }),
];

describe("matches", () => {
  test("an empty query matches everything", () => {
    expect(PROVIDERS.every((p) => matches(p, ""))).toBe(true);
  });

  test("plain substring, case-insensitively", () => {
    expect(matches(item("MiniMax (minimax.io)"), "mini")).toBe(true);
    expect(matches(item("MiniMax (minimax.io)"), "MINIMAX")).toBe(true);
    expect(matches(item("OpenAI"), "mini")).toBe(false);
  });

  test("subsequence matching, the way opencode's search feels", () => {
    expect(matches(item("OpenAI"), "oai")).toBe(true);
    expect(matches(item("MiniMax (minimax.io)"), "mnmx")).toBe(true);
    expect(matches(item("OpenRouter"), "zzz")).toBe(false);
  });

  test("searches the value and hint, not just the label", () => {
    expect(matches(item("Groq", { hint: "llama-3.3-70b" }), "llama")).toBe(true);
    expect(matches({ value: "bedrock", label: "Amazon" }, "bedrock")).toBe(true);
  });

  test("the loose pass never reads the hint", () => {
    // Caught end-to-end: typing "M3" selected MiniMax-M2, because the price
    // hint "$0.3/$1.2" let the subsequence m→3 match every model.
    const m2 = item("MiniMax-M2", { hint: "205k ctx · $0.3/$1.2 per Mtok" });
    expect(matches(m2, "m3")).toBe(false);
    expect(matches(item("MiniMax-M3", { hint: "1049k ctx" }), "m3")).toBe(true);
  });
});

describe("rank", () => {
  test("orders prefix above substring above hint above subsequence", () => {
    expect(rank(item("MiniMax-M3"), "minimax")).toBe(MatchRank.Prefix);
    expect(rank(item("Azure MiniMax"), "minimax")).toBe(MatchRank.Substring);
    expect(rank(item("Groq", { hint: "llama-3.3" }), "llama")).toBe(MatchRank.Hint);
    expect(rank(item("OpenAI"), "oai")).toBe(MatchRank.Subsequence);
    expect(rank(item("OpenAI"), "zzz")).toBe(MatchRank.None);
  });
});

describe("filterItems", () => {
  test("narrows to the matching rows, order preserved within a rank", () => {
    expect(filterItems(PROVIDERS, "mini").map((p) => p.label)).toEqual([
      "MiniMax (minimax.io)",
      "MiniMax Coding Plan",
    ]);
  });

  test("an exact hit outranks a fuzzy one, so Enter picks what you typed", () => {
    const models = [
      item("MiniMax-M2", { hint: "$0.3/$1.2 per Mtok" }),
      item("MiniMax-M2.7", { hint: "$0.3/$1.2 per Mtok" }),
      item("MiniMax-M3", { hint: "$0.3/$1.2 per Mtok" }),
    ];
    expect(filterItems(models, "M3").map((p) => p.label)).toEqual(["MiniMax-M3"]);
  });

  test("disabled rows still match — they are shown, not hidden", () => {
    expect(filterItems(PROVIDERS, "bedrock").map((p) => p.label)).toEqual(["Amazon Bedrock"]);
  });

  test("no match yields an empty list rather than everything", () => {
    expect(filterItems(PROVIDERS, "qqqq")).toEqual([]);
  });
});

describe("windowFor", () => {
  test("shows everything when it fits", () => {
    expect(windowFor(5, 0)).toEqual({ start: 0, end: 5 });
    expect(windowFor(5, 4)).toEqual({ start: 0, end: 5 });
  });

  test("keeps the highlight centred once the list overflows", () => {
    const view = windowFor(207, 100);
    expect(view.end - view.start).toBe(PICKER_VISIBLE_ROWS);
    expect(100).toBeGreaterThanOrEqual(view.start);
    expect(100).toBeLessThan(view.end);
  });

  test("clamps at both ends instead of scrolling past them", () => {
    expect(windowFor(207, 0)).toEqual({ start: 0, end: PICKER_VISIBLE_ROWS });
    expect(windowFor(207, 206)).toEqual({ start: 207 - PICKER_VISIBLE_ROWS, end: 207 });
  });

  test("an empty list produces an empty window, not a negative one", () => {
    expect(windowFor(0, 0)).toEqual({ start: 0, end: 0 });
  });
});
