import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.ts";
import { runCheck } from "../src/core/check.ts";
import { runTurn, type LoopEvent } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import type { TextBlock, ToolResultBlock } from "../src/core/types.ts";
import { builtinTools, makeRegistry } from "../src/tools/index.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider, text, toolUse, type ScriptedTurn } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const never = new AbortController().signal;
const cfg = (command: string, over: Record<string, unknown> = {}) => ({
  command,
  timeoutMs: 10_000,
  maxOutputBytes: 4_000,
  ...over,
});

describe("runCheck", () => {
  test("exit 0 passes silently", async () => {
    expect(await runCheck(cfg("true"), dir, never)).toEqual({ kind: "pass" });
  });

  test("a failure carries the command, status, output, and marching orders", async () => {
    const out = await runCheck(cfg("echo 'src/x.ts(3,7): error TS2322'; exit 1"), dir, never);
    if (out.kind !== "fail") throw new Error(`expected fail, got ${out.kind}`);
    expect(out.feedback).toContain("<post_edit_check>");
    expect(out.feedback).toContain("(exit 1)");
    expect(out.feedback).toContain("error TS2322");
    expect(out.feedback).toContain("Do not re-apply the edit");
    expect(out.summary).toContain("error TS2322");
  });

  test("long output is capped in the middle, both ends kept", async () => {
    const out = await runCheck(
      cfg("seq 1 5000", { maxOutputBytes: 500 }) as ReturnType<typeof cfg>,
      dir,
      never,
    );
    // seq exits 0 — force a failure with a wrapper.
    const failing = await runCheck(
      cfg("seq 1 5000; exit 1", { maxOutputBytes: 500 }),
      dir,
      never,
    );
    expect(out.kind).toBe("pass");
    if (failing.kind !== "fail") throw new Error("expected fail");
    expect(failing.feedback).toContain("bytes elided");
    expect(failing.feedback).toContain("\n1\n"); // head survived
    expect(failing.feedback).toContain("5000"); // tail survived
  });

  test("command-not-found is a broken config, not model feedback", async () => {
    const out = await runCheck(cfg("definitely-not-a-real-tool-xyz"), dir, never);
    if (out.kind !== "broken") throw new Error(`expected broken, got ${out.kind}`);
    expect(out.notice).toContain("disabled for this session");
    expect(out.notice).toContain("check.command");
  });

  test("a timeout is feedback with the partial output, not a crash", async () => {
    const out = await runCheck(
      cfg("echo started; sleep 30", { timeoutMs: 300 }),
      dir,
      never,
    );
    if (out.kind !== "fail") throw new Error(`expected fail, got ${out.kind}`);
    expect(out.feedback).toContain("timed out after 300ms");
    expect(out.feedback).toContain("started");
  }, 10_000);
});

describe("post-edit check in the loop", () => {
  const session = (checkCommand: string, script: ScriptedTurn[]) => {
    const provider = new MockProvider(script);
    return {
      provider,
      session: new Session({
        cwd: dir,
        config: ConfigSchema.parse({ check: { command: checkCommand } }),
        provider,
        projectDir: dir,
      }),
    };
  };

  const collect = async (gen: AsyncGenerator<LoopEvent, void, undefined>) => {
    const events: LoopEvent[] = [];
    for await (const e of gen) events.push(e);
    return events;
  };

  const edit = (): ScriptedTurn => ({
    content: [toolUse("t1", "write_file", { path: "x.txt", content: "hello" })],
    stopReason: "tool_use",
  });

  test("a failing check lands in the same message as the tool results", async () => {
    const { provider, session: s } = session("echo BROKEN-BY-EDIT; exit 1", [
      edit(),
      { content: [text("fixing…")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(s, "go", { registry: makeRegistry(builtinTools) }, never),
    );

    // The edit itself succeeded — the check is information, not a verdict.
    const end = events.find((e) => e.type === "tool_end")!;
    expect(end.type === "tool_end" && end.result.isError).toBe(false);
    expect(events.some((e) => e.type === "check" && !e.ok)).toBe(true);

    // The model's next request sees tool_result AND the feedback, together.
    const followup = provider.requests[1]!.messages.at(-1)!;
    const kinds = followup.content.map((b) => b.type);
    expect(kinds).toEqual(["tool_result", "text"]);
    expect((followup.content[0] as ToolResultBlock).is_error).toBe(false);
    expect((followup.content[1] as TextBlock).text).toContain("<post_edit_check>");
    expect((followup.content[1] as TextBlock).text).toContain("BROKEN-BY-EDIT");
  });

  test("a passing check costs the model nothing", async () => {
    const { provider, session: s } = session("true", [
      edit(),
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(s, "go", { registry: makeRegistry(builtinTools) }, never),
    );

    expect(events.some((e) => e.type === "check" && e.ok)).toBe(true);
    const followup = provider.requests[1]!.messages.at(-1)!;
    expect(followup.content.map((b) => b.type)).toEqual(["tool_result"]);
  });

  test("a read-only batch never triggers the check", async () => {
    const { session: s } = session("exit 1", [
      { content: [toolUse("t1", "glob", { pattern: "*.ts" })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(s, "go", { registry: makeRegistry(builtinTools) }, never),
    );
    expect(events.some((e) => e.type === "check")).toBe(false);
  });

  test("a failed edit does not trigger the check — nothing changed", async () => {
    const { session: s } = session("exit 1", [
      {
        content: [
          toolUse("t1", "edit_file", { path: "missing.ts", old_str: "a", new_str: "b" }),
        ],
        stopReason: "tool_use",
      },
      { content: [text("oops")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(s, "go", { registry: makeRegistry(builtinTools) }, never),
    );
    expect(events.some((e) => e.type === "check")).toBe(false);
  });

  test("an unrunnable check disables itself after one notice", async () => {
    const { session: s } = session("definitely-not-a-real-tool-xyz", [
      edit(),
      {
        content: [toolUse("t2", "write_file", { path: "y.txt", content: "again" })],
        stopReason: "tool_use",
      },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(s, "go", { registry: makeRegistry(builtinTools) }, never),
    );

    const notices = events.filter(
      (e) => e.type === "notice" && e.text.includes("disabled for this session"),
    );
    expect(notices).toHaveLength(1); // said once, for two mutating batches
    expect(s.checkBroken).toBe(true);
    expect(events.some((e) => e.type === "check")).toBe(false);
  });
});
