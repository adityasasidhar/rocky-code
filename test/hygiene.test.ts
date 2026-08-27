import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createArchiver, nullArchiver } from "../src/core/archive.ts";
import { capToolResult } from "../src/core/hygiene.ts";
import { compactNumber, meter } from "../src/tui/ansi.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const result = (output: string, isError = false) => ({ output, isError });

describe("capToolResult", () => {
  test("passes a small result through untouched", () => {
    const archiver = createArchiver(dir);
    const r = capToolResult(result("small"), "bash", 1000, archiver);
    expect(r.output).toBe("small");
    expect(r.meta).toBeUndefined();
  });

  test("caps an oversized result and stays within the budget", () => {
    const r = capToolResult(result("x".repeat(5000)), "bash", 500, nullArchiver);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(500);
    expect(r.output).toContain("bytes elided");
  });

  test("archives the full output and points the model at it", () => {
    const archiver = createArchiver(dir);
    const full = "y".repeat(5000);
    const r = capToolResult(result(full), "grep", 400, archiver);

    const path = r.meta?.["archivedAt"] as string;
    expect(path).toBeTruthy();
    expect(r.output).toContain(`full output at ${path}`);
    expect(readFileSync(path, "utf8")).toBe(full);
  });

  test("records how much was dropped", () => {
    const r = capToolResult(result("z".repeat(5000)), "bash", 400, nullArchiver);
    expect(r.meta?.["truncated"]).toBe(true);
    expect(r.meta?.["originalBytes"]).toBe(5000);
  });

  test("says so when archiving failed, rather than pointing at nothing", () => {
    const r = capToolResult(result("z".repeat(5000)), "bash", 400, nullArchiver);
    expect(r.output).toContain("output was not archived");
    expect(r.meta?.["archivedAt"]).toBeUndefined();
  });

  test("preserves isError and existing meta", () => {
    const r = capToolResult(
      { output: "q".repeat(5000), isError: true, meta: { exitCode: 3 } },
      "bash",
      400,
      nullArchiver,
    );
    expect(r.isError).toBe(true);
    expect(r.meta?.["exitCode"]).toBe(3);
  });

  test("measures bytes, not characters", () => {
    // 300 emoji = 1200 bytes, well over a 500-byte cap.
    const r = capToolResult(result("😀".repeat(300)), "bash", 500, nullArchiver);
    expect(r.output).toContain("bytes elided");
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(500);
  });
});

describe("createArchiver", () => {
  test("numbers files sequentially within a session", () => {
    const archiver = createArchiver(dir);
    const a = archiver("bash", "one")!;
    const b = archiver("grep", "two")!;
    expect(a).toContain("0001-bash.txt");
    expect(b).toContain("0002-grep.txt");
  });

  test("two sessions do not collide, because the counter is not global", () => {
    const one = createArchiver(`${dir}/a`);
    const two = createArchiver(`${dir}/b`);
    expect(one("bash", "x")).toContain("/a/outputs/0001-bash.txt");
    expect(two("bash", "y")).toContain("/b/outputs/0001-bash.txt");
  });

  test("an unwritable directory returns undefined rather than throwing", () => {
    expect(createArchiver("/proc/nope")("bash", "x")).toBeUndefined();
  });
});

describe("meter", () => {
  test("empty at zero, full at one", () => {
    expect(meter(0, 4)).toContain("░░░░");
    expect(meter(1, 4)).toContain("████");
  });

  test("clamps above one", () => {
    expect(meter(5, 4)).toContain("████");
  });

  test("a non-zero fraction always shows at least one block", () => {
    expect(meter(0.01, 10)).toContain("█");
  });

  test("tolerates NaN from a zero-width context", () => {
    expect(() => meter(Number.NaN)).not.toThrow();
    expect(meter(Number.NaN, 4)).toContain("░░░░");
  });
});

describe("compactNumber", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1000, "1.0k"],
    [9999, "10.0k"],
    [12_345, "12k"],
    [1_500_000, "1.5M"],
  ])("%i -> %s", (n, expected) => {
    expect(compactNumber(n)).toBe(expected);
  });
});
