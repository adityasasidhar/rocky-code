import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { defaultConfig } from "../src/config/schema.ts";
import { runTurn, type LoopDeps, type LoopEvent } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import type { ContentBlock, ToolResultBlock } from "../src/core/types.ts";
import { makeRegistry } from "../src/tools/index.ts";
import { erase, jsonSchemaOf, ok, type Tool } from "../src/tools/types.ts";
import { cleanup, tempDir } from "./helpers.ts";
import { MockProvider, text, toolUse, type ScriptedTurn } from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const schema = z.object({ value: z.string() });

/** A tool whose behavior each test controls. */
function fakeTool(
  name: string,
  readOnly: boolean,
  run: (input: { value: string }) => Promise<ReturnType<typeof ok>>,
): Tool<{ value: string }> {
  return {
    name,
    description: `fake ${name}`,
    schema,
    jsonSchema: jsonSchemaOf(schema),
    readOnly,
    summarize: (i) => i.value,
    run,
  };
}

function setup(script: ScriptedTurn[], tools: Tool<{ value: string }>[] = []) {
  const provider = new MockProvider(script);
  const session = new Session({
    cwd: dir,
    config: defaultConfig(),
    provider,
    projectDir: dir,
  });
  const registry = makeRegistry(tools.map(erase));
  return { provider, session, registry };
}

async function collect(
  gen: AsyncGenerator<LoopEvent, void, undefined>,
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const toolResults = (content: ContentBlock[]): ToolResultBlock[] =>
  content.filter((b): b is ToolResultBlock => b.type === "tool_result");

describe("agent loop", () => {
  test("a text-only response ends the turn and records the exchange", async () => {
    const { session, registry, provider } = setup([
      { content: [text("Hello.")], stopReason: "end_turn", usage: { outputTokens: 5 } },
    ]);

    const events = await collect(
      runTurn(session, "hi", { registry }, new AbortController().signal),
    );

    expect(events.map((e) => e.type)).toEqual(["text_delta", "turn_end"]);
    expect(provider.callCount).toBe(1);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    });
    expect(session.totalUsage.outputTokens).toBe(5);
    expect(session.turns).toBe(1);
  });

  test("runs a tool, feeds the result back, and continues", async () => {
    const calls: string[] = [];
    const tool = fakeTool("echo", true, async (i) => {
      calls.push(i.value);
      return ok(`echoed ${i.value}`);
    });

    const { session, registry, provider } = setup(
      [
        { content: [toolUse("t1", "echo", { value: "a" })], stopReason: "tool_use" },
        { content: [text("Done.")], stopReason: "end_turn" },
      ],
      [tool],
    );

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    expect(calls).toEqual(["a"]);
    expect(events.map((e) => e.type)).toEqual([
      "tool_start",
      "tool_end",
      "text_delta",
      "turn_end",
    ]);

    // The second request must carry the tool_result.
    const second = provider.requests[1]!;
    const results = toolResults(second.messages.at(-1)!.content);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool_use_id: "t1",
      content: "echoed a",
      is_error: false,
    });
  });

  test("every tool_use gets exactly one tool_result, in a single user message", async () => {
    const tool = fakeTool("echo", true, async (i) => ok(i.value));
    const { session, registry, provider } = setup(
      [
        {
          content: [
            toolUse("t1", "echo", { value: "a" }),
            toolUse("t2", "echo", { value: "b" }),
            toolUse("t3", "echo", { value: "c" }),
          ],
          stopReason: "tool_use",
        },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    const lastUser = provider.requests[1]!.messages.at(-1)!;
    expect(lastUser.role).toBe("user");
    const results = toolResults(lastUser.content);
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2", "t3"]);
    expect(lastUser.content).toHaveLength(3);
  });

  test("read-only tools in one batch run concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tool = fakeTool("slow", true, async (i) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Bun.sleep(30);
      inFlight--;
      return ok(i.value);
    });

    const { session, registry } = setup(
      [
        {
          content: [
            toolUse("t1", "slow", { value: "a" }),
            toolUse("t2", "slow", { value: "b" }),
          ],
          stopReason: "tool_use",
        },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));
    expect(maxInFlight).toBe(2);
  });

  test("mutating tools run serially, never interleaved", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tool = fakeTool("write", false, async (i) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Bun.sleep(20);
      inFlight--;
      return ok(i.value);
    });

    const { session, registry } = setup(
      [
        {
          content: [
            toolUse("t1", "write", { value: "a" }),
            toolUse("t2", "write", { value: "b" }),
          ],
          stopReason: "tool_use",
        },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));
    expect(maxInFlight).toBe(1);
  });

  test("a mixed batch runs serially", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const body = async (i: { value: string }) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await Bun.sleep(20);
      inFlight--;
      return ok(i.value);
    };

    const { session, registry } = setup(
      [
        {
          content: [
            toolUse("t1", "read", { value: "a" }),
            toolUse("t2", "write", { value: "b" }),
          ],
          stopReason: "tool_use",
        },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [fakeTool("read", true, body), fakeTool("write", false, body)],
    );

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));
    expect(maxInFlight).toBe(1);
  });
});

describe("agent loop — failure paths", () => {
  test("an unknown tool becomes an error result, not a crash", async () => {
    const { session, registry, provider } = setup([
      { content: [toolUse("t1", "nope", {})], stopReason: "tool_use" },
      { content: [text("recovered")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
    const results = toolResults(provider.requests[1]!.messages.at(-1)!.content);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Unknown tool: nope");
  });

  test("invalid tool input is rejected at the boundary with a usable message", async () => {
    const tool = fakeTool("echo", true, async () => ok("never"));
    const { session, registry, provider } = setup(
      [
        // `value` must be a string.
        { content: [toolUse("t1", "echo", { value: 42 })], stopReason: "tool_use" },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));
    const results = toolResults(provider.requests[1]!.messages.at(-1)!.content);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Invalid input for echo");
    expect(results[0]!.content).toContain("value");
  });

  test("a throwing tool handler is surfaced to the model and the session survives", async () => {
    const tool = fakeTool("boom", true, async () => {
      throw new Error("kaboom");
    });
    const { session, registry, provider } = setup(
      [
        { content: [toolUse("t1", "boom", { value: "x" })], stopReason: "tool_use" },
        { content: [text("handled")], stopReason: "end_turn" },
      ],
      [tool],
    );

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
    const results = toolResults(provider.requests[1]!.messages.at(-1)!.content);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("boom threw: kaboom");
  });

  test("a denied tool is never executed and the model is told why", async () => {
    let ran = false;
    const tool = fakeTool("write", false, async () => {
      ran = true;
      return ok("wrote");
    });

    const deps: LoopDeps = {
      registry: makeRegistry([erase(tool)]),
      approve: async () => ({ allow: false, reason: "user said no" }),
    };
    const provider = new MockProvider([
      { content: [toolUse("t1", "write", { value: "x" })], stopReason: "tool_use" },
      { content: [text("understood")], stopReason: "end_turn" },
    ]);
    const session = new Session({
      cwd: dir,
      config: defaultConfig(),
      provider,
      projectDir: dir,
    });

    const events = await collect(runTurn(session, "go", deps, new AbortController().signal));

    expect(ran).toBe(false);
    expect(events.some((e) => e.type === "tool_denied")).toBe(true);
    const results = toolResults(provider.requests[1]!.messages.at(-1)!.content);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("user said no");
  });

  test("a run of fully-denied turns stops instead of burning the iteration cap", async () => {
    const tool = fakeTool("write", false, async () => ok("wrote"));
    const provider = new MockProvider(
      Array.from({ length: 10 }, () => ({
        content: [toolUse("t", "write", { value: "x" })],
        stopReason: "tool_use" as const,
      })),
    );
    const session = new Session({
      cwd: dir,
      config: defaultConfig(),
      provider,
      projectDir: dir,
    });

    const events = await collect(
      runTurn(
        session,
        "go",
        {
          registry: makeRegistry([erase(tool)]),
          approve: async () => ({ allow: false, reason: "no" }),
          maxIterations: 10,
        },
        new AbortController().signal,
      ),
    );

    // Two fully-denied iterations, then stop. Not ten.
    expect(provider.callCount).toBe(2);
    expect(
      events.some((e) => e.type === "notice" && e.text.includes("consecutive turns")),
    ).toBe(true);
    // Stalling against permissions is not finishing.
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "denied" });

    // The transcript is still valid: every tool_use has a tool_result.
    const uses = session.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use").map((b) => b.id),
    );
    const results = session.messages.flatMap((m) =>
      toolResults(m.content).map((b) => b.tool_use_id),
    );
    expect(results).toHaveLength(uses.length);
  });

  test("a denied turn followed by a successful one resets the streak", async () => {
    const tool = fakeTool("write", false, async () => ok("wrote"));
    let calls = 0;
    const provider = new MockProvider([
      { content: [toolUse("t1", "write", { value: "x" })], stopReason: "tool_use" },
      { content: [toolUse("t2", "write", { value: "y" })], stopReason: "tool_use" },
      { content: [toolUse("t3", "write", { value: "z" })], stopReason: "tool_use" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);
    const session = new Session({
      cwd: dir,
      config: defaultConfig(),
      provider,
      projectDir: dir,
    });

    const events = await collect(
      runTurn(
        session,
        "go",
        {
          registry: makeRegistry([erase(tool)]),
          // Deny, allow, deny — the streak never reaches 2.
          approve: async () => (++calls === 2 ? { allow: true } : { allow: false, reason: "no" }),
        },
        new AbortController().signal,
      ),
    );

    expect(provider.callCount).toBe(4);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
  });

  test("abort before the turn starts ends cleanly", async () => {
    const { session, registry } = setup([{ content: [text("x")], stopReason: "end_turn" }]);
    const ac = new AbortController();
    ac.abort();

    const events = await collect(runTurn(session, "go", { registry }, ac.signal));
    expect(events).toEqual([
      { type: "turn_end", stopReason: "aborted", usage: expect.anything() },
    ]);
  });

  test("abort mid-turn leaves no dangling tool_use in the transcript", async () => {
    const ac = new AbortController();
    const tool = fakeTool("slow", false, async (i) => {
      ac.abort();
      return ok(i.value);
    });

    const { session, registry } = setup(
      [
        { content: [toolUse("t1", "slow", { value: "a" })], stopReason: "tool_use" },
        { content: [text("never reached")], stopReason: "end_turn" },
      ],
      [tool],
    );

    const events = await collect(runTurn(session, "go", { registry }, ac.signal));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "aborted" });

    // Invariant: each tool_use has a matching tool_result somewhere after it.
    const uses = session.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use").map((b) => b.id),
    );
    const results = session.messages.flatMap((m) =>
      toolResults(m.content).map((b) => b.tool_use_id),
    );
    expect(results.sort()).toEqual(uses.sort());
  });

  test("the iteration guard stops a runaway tool loop", async () => {
    const tool = fakeTool("loop", true, async () => ok("again"));
    // The model never stops calling tools.
    const script: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      content: [toolUse("t", "loop", { value: "x" })],
      stopReason: "tool_use" as const,
    }));

    const { session, registry, provider } = setup(script, [tool]);
    const events = await collect(
      runTurn(session, "go", { registry, maxIterations: 3 }, new AbortController().signal),
    );

    expect(provider.callCount).toBe(3);
    expect(events.some((e) => e.type === "notice" && e.text.includes("3 tool iterations"))).toBe(
      true,
    );
    // "Gave up" must be distinguishable from "finished": a sub-agent that hit
    // the cap once reported its partial work as a complete report.
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "max_iterations" });
  });

  test("max_tokens emits a notice so the user is not silently truncated", async () => {
    const { session, registry } = setup([
      { content: [text("partial")], stopReason: "max_tokens" },
    ]);
    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );
    expect(events.some((e) => e.type === "notice" && e.text.includes("max_tokens"))).toBe(
      true,
    );
  });

  test("pause_turn resumes without inventing tool results", async () => {
    const { session, registry, provider } = setup([
      { content: [text("thinking…")], stopReason: "pause_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));
    expect(provider.callCount).toBe(2);
    // No synthetic user turn was appended between the two assistant messages.
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
  });
});

describe("tool-result hygiene", () => {
  test("every tool's output is capped, archived, and pointed at", async () => {
    const big = "x".repeat(80_000);
    const tool = fakeTool("dump", true, async () => ok(big));

    const { session, registry, provider } = setup(
      [
        { content: [toolUse("t1", "dump", { value: "a" })], stopReason: "tool_use" },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );
    session.config.maxToolResultBytes = 1000;

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const end = events.find((e) => e.type === "tool_end");
    expect(end).toBeDefined();
    if (end?.type !== "tool_end") return;

    expect(Buffer.byteLength(end.result.output, "utf8")).toBeLessThanOrEqual(1000);
    expect(end.result.output).toContain("bytes elided");
    expect(end.result.meta?.["originalBytes"]).toBe(80_000);

    // The model sees the capped copy, and can go read the full one.
    const archived = end.result.meta?.["archivedAt"] as string;
    expect(readFileSync(archived, "utf8")).toBe(big);

    const sent = provider.requests[1]!.messages.at(-1)!.content[0]!;
    expect(sent.type === "tool_result" && sent.content).toContain("full output at");
  });

  test("a tool that already fits is not rewritten", async () => {
    const tool = fakeTool("small", true, async () => ok("tiny"));
    const { session, registry } = setup(
      [
        { content: [toolUse("t1", "small", { value: "a" })], stopReason: "tool_use" },
        { content: [text("ok")], stopReason: "end_turn" },
      ],
      [tool],
    );

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );
    const end = events.find((e) => e.type === "tool_end");
    if (end?.type !== "tool_end") throw new Error("no tool_end");
    expect(end.result.output).toBe("tiny");
    expect(end.result.meta?.["truncated"]).toBeUndefined();
  });
});

describe("auto-compaction", () => {
  /** Fill the meter past the threshold before the turn begins. */
  const overfill = (session: Session) =>
    session.recordUsage({
      inputTokens: 190_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

  test("fires before the request when the window is nearly full", async () => {
    const { session, registry, provider } = setup([
      // 1: the summarization call. 2: the actual turn.
      { content: [text("## Task\nrecap")], stopReason: "end_turn" },
      { content: [text("answer")], stopReason: "end_turn" },
    ]);
    session.messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "1" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "2" }] },
    ];
    overfill(session);

    const events = await collect(
      runTurn(session, "c", { registry }, new AbortController().signal),
    );

    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type !== "compacted") return;
    expect(compacted.droppedMessages).toBeGreaterThan(0);
    expect(compacted.recap).toContain("recap");

    expect(provider.callCount).toBe(2);
    expect(session.compactions).toBe(1);

    // The real request went out with the compacted history.
    expect(provider.requests[1]!.messages.length).toBeLessThan(5);
  });

  test("does not fire below the threshold", async () => {
    const { session, registry, provider } = setup([
      { content: [text("answer")], stopReason: "end_turn" },
    ]);
    session.recordUsage({
      inputTokens: 1000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(provider.callCount).toBe(1);
  });

  test("autoCompact: false disables it entirely", async () => {
    const { session, registry, provider } = setup([
      { content: [text("answer")], stopReason: "end_turn" },
    ]);
    session.messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "1" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ];
    overfill(session);

    await collect(
      runTurn(session, "c", { registry, autoCompact: false }, new AbortController().signal),
    );
    expect(provider.callCount).toBe(1);
  });

  test("when nothing can be dropped, it says so once and stops retrying", async () => {
    const { session, registry, provider } = setup([
      { content: [text("answer")], stopReason: "end_turn" },
    ]);
    // A single in-flight turn: no safe cut point exists.
    overfill(session);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    if (notice?.type !== "notice") return;
    expect(notice.text).toContain("95% full");
    expect(notice.text).toContain("not enough conversation");

    // No summarization call was wasted, and the turn still ran.
    expect(provider.callCount).toBe(1);
    expect(session.needsCompaction).toBe(false);
  });

  /** A read-only tool, so the iteration loop can be made to go round again. */
  const peek = () => fakeTool("peek", true, async () => ok("peeked"));
  const call = (id: string): ContentBlock => toolUse(id, "peek", { value: "x" });
  const heavy = { inputTokens: 190_000, outputTokens: 0 };

  test("compaction fires at most once per turn even if the kept tail is still over threshold", async () => {
    const { session, registry, provider } = setup(
      [
        { content: [text("## Task\nrecap")], stopReason: "end_turn" }, // summarization
        // The turn that follows re-fills the meter, so iteration 1 would
        // compact again without the guard.
        { content: [call("t1")], stopReason: "tool_use", usage: heavy },
        { content: [text("done")], stopReason: "end_turn" },
      ],
      [peek()],
    );
    session.messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "1" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "2" }] },
    ];
    overfill(session);

    // keepTurns: 1 leaves a second cut viable after the first pass — without
    // the guard this session really would compact twice in one turn.
    const events = await collect(
      runTurn(
        session,
        "c",
        { registry, compaction: { keepTurns: 1, minDropped: 1 } },
        new AbortController().signal,
      ),
    );

    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(session.compactions).toBe(1);
    // One summarization + two real turns. A second pass would have made it 4.
    expect(provider.callCount).toBe(3);
    // The meter is still hot; the guard, not the meter, is what stopped it.
    expect(session.needsCompaction).toBe(true);
  });

  test("the flag resets between turns", async () => {
    const { session, registry, provider } = setup([
      { content: [text("## Task\nrecap one")], stopReason: "end_turn" },
      { content: [text("first")], stopReason: "end_turn" },
      { content: [text("## Task\nrecap two")], stopReason: "end_turn" },
      { content: [text("second")], stopReason: "end_turn" },
    ]);
    session.messages = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "1" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "2" }] },
    ];

    overfill(session);
    const first = await collect(
      runTurn(session, "c", { registry }, new AbortController().signal),
    );
    overfill(session);
    const second = await collect(
      runTurn(session, "d", { registry }, new AbortController().signal),
    );

    expect(first.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(second.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(session.compactions).toBe(2);
    expect(provider.callCount).toBe(4);
  });

  test("a no-op compaction (nothing safe to drop) does not latch the flag for this turn", async () => {
    const { session, registry, provider } = setup(
      [
        { content: [call("t1")], stopReason: "tool_use" },
        { content: [text("done")], stopReason: "end_turn" },
      ],
      [peek()],
    );
    // A single in-flight turn: no safe cut point exists, on any iteration.
    overfill(session);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const notices = events.filter(
      (e) => e.type === "notice" && e.text.includes("not enough conversation"),
    );
    // The meter reset by the no-op keeps iteration 1 quiet; the guard is not
    // what silenced it, which is why the flag stays open.
    expect(notices).toHaveLength(1);
    expect(provider.callCount).toBe(2);
    expect(session.compactions).toBe(0);
  });

  test("a no-op leaves the guard open, so a later iteration in the same turn can still compact", async () => {
    const { session, registry, provider } = setup(
      [
        // Two tool iterations, each re-filling the meter and each growing the
        // transcript until a safe cut finally exists.
        { content: [call("t1")], stopReason: "tool_use", usage: heavy },
        { content: [call("t2")], stopReason: "tool_use", usage: heavy },
        { content: [text("## Task\nrecap")], stopReason: "end_turn" }, // summarization
        { content: [text("done")], stopReason: "end_turn" },
      ],
      [peek()],
    );
    overfill(session);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const notices = events.filter(
      (e) => e.type === "notice" && e.text.includes("not enough conversation"),
    );
    expect(notices).toHaveLength(2);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(provider.callCount).toBe(4);
  });
});

describe("session accounting", () => {
  test("usage accumulates and cost prices cache reads and writes differently", async () => {
    const { session, registry } = setup([
      {
        content: [text("hi")],
        stopReason: "end_turn",
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 200,
          cacheReadInputTokens: 4000,
        },
      },
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    // input 1e-6, output 2e-6 from MockProvider.pricing()
    const expected = 1000 * 1e-6 + 200 * 1e-6 * 1.25 + 4000 * 1e-6 * 0.1 + 500 * 2e-6;
    expect(session.costUsd).toBeCloseTo(expected, 10);
    // The context meter reflects the whole prompt, not just uncached input.
    expect(session.lastPromptTokens).toBe(5200);
    expect(session.contextUsed).toBeCloseTo(5200 / 200_000, 6);
  });
});
