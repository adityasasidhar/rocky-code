import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config/schema.ts";
import { buildSystemPrompt } from "../src/core/prompt.ts";
import { Session } from "../src/core/session.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const session = () =>
  new Session({
    cwd: dir,
    config: defaultConfig(),
    provider: new MockProvider([]),
    projectDir: dir,
  });

describe("Session", () => {
  test("creates its session directory", () => {
    const s = session();
    expect(existsSync(s.sessionDir)).toBe(true);
    expect(s.sessionDir).toContain(join(".rocky", "session"));
  });

  test(".rocky ignores itself, so it never appears in the user's git status", () => {
    session();
    const ignore = join(dir, ".rocky", ".gitignore");
    expect(existsSync(ignore)).toBe(true);
    expect(readFileSync(ignore, "utf8")).toBe("*\n");
  });

  test("an existing .rocky/.gitignore is left alone", () => {
    session();
    const ignore = join(dir, ".rocky", ".gitignore");
    Bun.write(ignore, "# custom\n");
    session();
    // Two sessions, one file, not clobbered.
    expect(readFileSync(ignore, "utf8")).toBe("# custom\n");
  });

  test("empty messages are never appended", () => {
    const s = session();
    s.append({ role: "user", content: [] });
    expect(s.messages).toHaveLength(0);
  });

  test("usage accumulates across turns", () => {
    const s = session();
    s.recordUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    s.recordUsage({
      inputTokens: 3,
      outputTokens: 2,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 4,
    });
    expect(s.totalUsage.inputTokens).toBe(13);
    expect(s.totalUsage.outputTokens).toBe(7);
    expect(s.totalUsage.cacheReadInputTokens).toBe(4);
  });

  test("uses authoritative backend cost when the backend owns provider billing", () => {
    const s = session();
    s.recordBackendCost(0.012);
    s.recordBackendCost(0.003);
    expect(s.costUsd).toBeCloseTo(0.015, 10);
  });

  test("a zero-usage turn does not reset the context meter", () => {
    const s = session();
    s.recordUsage({
      inputTokens: 100,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // An aborted turn reports zero usage; the meter should hold its last value.
    s.recordUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(s.lastPromptTokens).toBe(100);
  });
});

describe("buildSystemPrompt", () => {
  test("includes cwd, platform, and a directory snapshot", () => {
    const text = buildSystemPrompt(dir)
      .map((s) => s.text)
      .join("\n");
    expect(text).toContain(`Working directory: ${dir}`);
    expect(text).toContain("Platform:");
    expect(text).toContain("Directory contents:");
    expect(text).toContain("Git repo:");
  });

  test("does not leak .rocky into the directory snapshot", () => {
    session(); // creates .rocky
    const text = buildSystemPrompt(dir)
      .map((s) => s.text)
      .join("\n");
    expect(text).not.toContain(".rocky");
  });

  test("instructions come first and are marked cacheable", () => {
    const segments = buildSystemPrompt(dir);
    expect(segments[0]!.text).toContain("You are Rocky");
    expect(segments[0]!.cache).toBe(true);
    expect(segments.at(-1)!.text).toContain("<environment>");
  });

  test("extra segments land between the instructions and the environment", () => {
    const segments = buildSystemPrompt(dir, ["PROJECT MEMORY"]);
    expect(segments).toHaveLength(3);
    expect(segments[1]!.text).toBe("PROJECT MEMORY");
  });

  test("blank extra segments are dropped", () => {
    expect(buildSystemPrompt(dir, ["", "   "])).toHaveLength(2);
  });

  test("a non-git directory is reported as such", () => {
    const text = buildSystemPrompt(dir)
      .map((s) => s.text)
      .join("\n");
    expect(text).toContain("Git repo: no");
  });
});
