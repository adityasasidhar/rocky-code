import { describe, expect, test } from "bun:test";
import {
  diffLines,
  diffStats,
  editDistance,
  findClosestBlock,
  formatDiff,
  occurrenceLines,
  similarity,
} from "../src/core/diff.ts";

describe("diffLines", () => {
  test("identical input produces only context", () => {
    const ops = diffLines(["a", "b"], ["a", "b"]);
    expect(ops.every((o) => o.kind === "ctx")).toBe(true);
  });

  test("detects a single-line change", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "B", "c"]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });

  test("insertion adds without removing", () => {
    const ops = diffLines(["a", "c"], ["a", "b", "c"]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 0 });
  });

  test("formatDiff elides runs of unchanged lines", () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[15] = "changed";
    const out = formatDiff(diffLines(a, b), 2);
    expect(out).toContain("…");
    expect(out).toContain("- line 15");
    expect(out).toContain("+ changed");
    expect(out).not.toContain("line 0");
  });
});

describe("editDistance / similarity", () => {
  test("distance basics", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  test("similarity is 1 for identical, low for unrelated", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("hello world", "hello werld")).toBeGreaterThan(0.85);
    expect(similarity("abc", "xyz")).toBeLessThan(0.4);
  });
});

describe("occurrenceLines", () => {
  const file = "one\ntwo\nthree\ntwo\n";

  test("returns 1-indexed lines of every occurrence", () => {
    expect(occurrenceLines(file, "two")).toEqual([2, 4]);
  });

  test("returns empty for no match", () => {
    expect(occurrenceLines(file, "four")).toEqual([]);
  });

  test("counts non-overlapping occurrences", () => {
    expect(occurrenceLines("aaaa", "aa")).toEqual([1, 1]);
  });
});

describe("findClosestBlock", () => {
  const file = ["function add(a, b) {", "  return a + b;", "}", "", "const x = 1;"].join(
    "\n",
  );

  test("finds a near-match differing only in indentation", () => {
    const match = findClosestBlock(file, "function add(a, b) {\n    return a + b;\n}");
    expect(match).toBeDefined();
    expect(match!.startLine).toBe(1);
    expect(match!.score).toBeGreaterThan(0.8);
  });

  test("reports the correct start line for a later block", () => {
    const match = findClosestBlock(file, "const x = 2;");
    expect(match!.startLine).toBe(5);
  });

  test("returns undefined when nothing clears the threshold", () => {
    expect(findClosestBlock(file, "completely unrelated content here")).toBeUndefined();
  });

  test("returns undefined when the needle is taller than the file", () => {
    expect(findClosestBlock("a\nb", "a\nb\nc\nd\ne\nf")).toBeUndefined();
  });
});
