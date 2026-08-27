import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bashTool, runBash, shellQuote } from "../../src/tools/bash.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
let ctx: ReturnType<typeof makeCtx>;

beforeEach(() => {
  dir = tempDir();
  ctx = makeCtx(dir);
});
afterEach(() => cleanup(dir));

describe("shellQuote", () => {
  test("escapes single quotes safely", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("/a b/c")).toBe(`'/a b/c'`);
  });
});

describe("bash", () => {
  test("captures stdout", async () => {
    const r = await bashTool.run({ command: "echo hello" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("hello");
    expect(r.meta?.["exitCode"]).toBe(0);
  });

  test("captures stderr and a nonzero exit code as a tool error", async () => {
    const r = await bashTool.run({ command: "echo oops >&2; exit 3" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Exit code 3");
    expect(r.output).toContain("oops");
    expect(r.meta?.["exitCode"]).toBe(3);
  });

  test("working directory persists across calls", async () => {
    mkdirSync(join(dir, "sub"));
    await bashTool.run({ command: "cd sub" }, ctx);
    expect(ctx.cwd).toBe(join(dir, "sub"));

    const r = await bashTool.run({ command: "pwd" }, ctx);
    expect(r.output).toContain("sub");
  });

  test("cwd survives a failing command", async () => {
    const before = ctx.cwd;
    await bashTool.run({ command: "false" }, ctx);
    expect(ctx.cwd).toBe(before);
  });

  test("times out and reports the limit", async () => {
    const r = await bashTool.run({ command: "sleep 5", timeout_ms: 150 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("timed out after 150ms");
    expect(r.meta?.["timedOut"]).toBe(true);
  });

  test("per-call timeout is clamped to bashMaxTimeoutMs", async () => {
    ctx.config.bashMaxTimeoutMs = 100;
    const r = await bashTool.run({ command: "sleep 5", timeout_ms: 60_000 }, ctx);
    expect(r.output).toContain("timed out after 100ms");
  });

  test("abort kills the process and reports interruption", async () => {
    const ac = new AbortController();
    const c = makeCtx(dir, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r = await bashTool.run({ command: "sleep 5" }, c);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("interrupted");
  });

  test("returns its output whole; capping is the loop's job", async () => {
    // Size limits live in core/hygiene.ts so every tool is bounded alike.
    // See test/hygiene.test.ts and the loop tests for the cap itself.
    ctx.config.maxToolResultBytes = 500;
    const r = await bashTool.run({ command: "yes abcdefgh | head -n 5000" }, ctx);
    expect(r.isError).toBe(false);
    expect(Buffer.byteLength(r.output)).toBeGreaterThan(500);
    expect(r.output).not.toContain("bytes elided");
  });

  test("empty output is reported explicitly", async () => {
    const r = await bashTool.run({ command: "true" }, ctx);
    expect(r.output).toBe("(no output)");
  });

  test("runBash reports the final cwd after a cd", async () => {
    mkdirSync(join(dir, "x"));
    const out = await runBash("cd x", dir, 5000, new AbortController().signal);
    expect(out.exitCode).toBe(0);
    expect(out.newCwd).toBe(join(dir, "x"));
  });

  test("summarize shows the command, never a paraphrase", () => {
    // A permission prompt that says "list files" instead of `rm -rf /` is a bug.
    expect(bashTool.summarize({ command: "ls -la" })).toBe("ls -la");
    expect(bashTool.summarize({ command: "a\nb" })).toBe("a …");
    expect(bashTool.summarize({ command: "x".repeat(200) })).toHaveLength(80);
  });

  test("preview is the full command, unabridged", () => {
    expect(bashTool.preview!({ command: "a\nb" }, ctx)).toBe("a\nb");
  });
});
