import { describe, expect, test } from "bun:test";
import { truncateMiddle } from "../src/core/truncate.ts";

describe("truncateMiddle", () => {
  test("passes short text through untouched", () => {
    const r = truncateMiddle("hello", 100);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.elidedBytes).toBe(0);
  });

  test("keeps head and tail, marks the elision, and reports byte count", () => {
    const text = `${"a".repeat(500)}${"b".repeat(500)}`;
    const r = truncateMiddle(text, 200);

    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("aaa")).toBe(true);
    expect(r.text.endsWith("bbb")).toBe(true);
    expect(r.text).toContain("bytes elided");
    expect(r.elidedBytes).toBeGreaterThan(700);
  });

  test("never exceeds the byte budget", () => {
    const text = "x".repeat(10_000);
    for (const budget of [120, 300, 1000, 5000]) {
      const r = truncateMiddle(text, budget);
      expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(budget);
    }
  });

  test("head + tail + elided accounts for every original byte", () => {
    const text = "y".repeat(3000);
    const r = truncateMiddle(text, 400);
    const kept = r.text.replace(/\n\n… \[.*?\] …\n\n/s, "");
    expect(kept.length + r.elidedBytes).toBe(3000);
  });

  test("does not split a multi-byte character", () => {
    const text = "😀".repeat(500); // 4 bytes each
    const r = truncateMiddle(text, 200);
    expect(r.text).not.toContain("�");
    // Round-tripping through UTF-8 must be lossless for the kept portion.
    expect(Buffer.from(r.text, "utf8").toString("utf8")).toBe(r.text);
  });

  test("appends a pointer to the archived full output", () => {
    const r = truncateMiddle("z".repeat(1000), 200, "full output at /tmp/x.txt");
    expect(r.text).toContain("full output at /tmp/x.txt");
  });
});
