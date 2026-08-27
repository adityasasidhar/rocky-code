import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/schema.ts";
import { runTurn, type LoopEvent } from "../../src/core/loop.ts";
import { Session } from "../../src/core/session.ts";
import { builtinTools, makeRegistry } from "../../src/tools/index.ts";
import { cleanup, tempDir } from "../helpers.ts";
import { MockProvider, text, toolUse, type ScriptedTurn } from "../mock_provider.ts";

/**
 * End-to-end: the real loop, the real tools, a real filesystem, a real
 * subprocess. Only the model is replayed. This is the shape the CI harness in
 * bench/ will reuse — swap the script, keep everything else.
 */

let repo: string;

const BUGGY = `export const add = (a: number, b: number): number => {
  return a - b;
};
`;

const VERIFY = `import { add } from "./src/math.ts";
if (add(2, 3) !== 5) {
  console.error(\`FAIL: add(2,3) returned \${add(2, 3)}, expected 5\`);
  process.exit(1);
}
console.log("PASS");
`;

beforeEach(() => {
  repo = tempDir();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "math.ts"), BUGGY);
  writeFileSync(join(repo, "verify.ts"), VERIFY);
});
afterEach(() => cleanup(repo));

const run = async (script: ScriptedTurn[]) => {
  const provider = new MockProvider(script);
  const session = new Session({
    cwd: repo,
    config: defaultConfig(),
    provider,
    projectDir: repo,
  });
  const events: LoopEvent[] = [];
  for await (const e of runTurn(
    session,
    "verify.ts fails. Find the bug and fix it.",
    { registry: makeRegistry(builtinTools) },
    new AbortController().signal,
  )) {
    events.push(e);
  }
  return { events, session, provider };
};

const toolEnds = (events: LoopEvent[]) =>
  events.filter((e): e is Extract<LoopEvent, { type: "tool_end" }> => e.type === "tool_end");

const math = () => readFileSync(join(repo, "src", "math.ts"), "utf8");

describe("integration: fix a failing check", () => {
  test("locate → read → edit → verify, and the bug is actually gone", async () => {
    const { events, session } = await run([
      {
        content: [toolUse("t1", "bash", { command: "bun run verify.ts" })],
        stopReason: "tool_use",
      },
      {
        content: [toolUse("t2", "grep", { pattern: "export const add" })],
        stopReason: "tool_use",
      },
      {
        content: [toolUse("t3", "read_file", { path: "src/math.ts" })],
        stopReason: "tool_use",
      },
      {
        content: [
          toolUse("t4", "edit_file", {
            path: "src/math.ts",
            old_str: "  return a - b;",
            new_str: "  return a + b;",
          }),
        ],
        stopReason: "tool_use",
      },
      {
        content: [toolUse("t5", "bash", { command: "bun run verify.ts" })],
        stopReason: "tool_use",
      },
      { content: [text("Fixed: `add` subtracted instead of adding.")], stopReason: "end_turn" },
    ]);

    const results = toolEnds(events);
    expect(results).toHaveLength(5);

    // The first run of verify.ts genuinely failed...
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain("expected 5");

    // ...grep found the function, read_file numbered it...
    expect(results[1]!.result.output).toContain("src/math.ts");
    expect(results[2]!.result.output).toContain("2\t  return a - b;");

    // ...the edit landed...
    expect(results[3]!.result.isError).toBe(false);
    expect(math()).toContain("return a + b;");

    // ...and verify.ts now passes, for real, in a real subprocess.
    expect(results[4]!.result.isError).toBe(false);
    expect(results[4]!.result.output).toContain("PASS");

    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
    expect(session.turns).toBe(6);
  }, 20_000);

  test("a botched edit_file self-corrects on the very next call", async () => {
    const { events } = await run([
      {
        // Wrong indentation — the classic failure.
        content: [
          toolUse("t1", "edit_file", {
            path: "src/math.ts",
            old_str: "    return a - b;",
            new_str: "    return a + b;",
          }),
        ],
        stopReason: "tool_use",
      },
      {
        // Corrected using the diagnostic the tool just returned.
        content: [
          toolUse("t2", "edit_file", {
            path: "src/math.ts",
            old_str: "  return a - b;",
            new_str: "  return a + b;",
          }),
        ],
        stopReason: "tool_use",
      },
      {
        content: [toolUse("t3", "bash", { command: "bun run verify.ts" })],
        stopReason: "tool_use",
      },
      { content: [text("Fixed.")], stopReason: "end_turn" },
    ]);

    const results = toolEnds(events);

    // The failure told the model exactly what was wrong, in one turn.
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain("0 matches");
    expect(results[0]!.result.output).toContain("closest text is at line 2");
    expect(results[0]!.result.output).toContain("leading whitespace");

    expect(results[1]!.result.isError).toBe(false);
    expect(results[2]!.result.output).toContain("PASS");
    expect(math()).toContain("return a + b;");
  }, 20_000);

  test("bash cwd persists across calls within the turn", async () => {
    const { events, session } = await run([
      { content: [toolUse("t1", "bash", { command: "cd src" })], stopReason: "tool_use" },
      { content: [toolUse("t2", "bash", { command: "pwd" })], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end_turn" },
    ]);

    expect(toolEnds(events)[1]!.result.output).toContain("/src");
    expect(session.cwd).toBe(join(repo, "src"));
  }, 20_000);

  test("full tool output is archived under .rocky and pointed at when truncated", async () => {
    const { events, session } = await run([
      {
        content: [
          toolUse("t1", "bash", { command: "yes 0123456789abcdef | head -n 4000" }),
        ],
        stopReason: "tool_use",
      },
      { content: [text("ok")], stopReason: "end_turn" },
    ]);

    // Shrink is applied via config default (30_000); output here is ~68KB.
    const out = toolEnds(events)[0]!.result.output;
    expect(out).toContain("bytes elided");
    expect(out).toContain("full output at");

    // The marker reads: … [N bytes elided; full output at /path] …
    const archived = out.match(/full output at ([^\]\s]+)/)?.[1];
    expect(archived).toBeDefined();
    expect(archived!.startsWith(session.sessionDir)).toBe(true);
    expect(readFileSync(archived!, "utf8").length).toBeGreaterThan(60_000);
  }, 20_000);
});
