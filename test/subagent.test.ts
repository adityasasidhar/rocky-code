import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config/schema.ts";
import { runTurn, type LoopEvent } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import type { ContentBlock, ToolResultBlock } from "../src/core/types.ts";
import { builtinTools, makeRegistry } from "../src/tools/index.ts";
import { cleanup, tempDir } from "./helpers.ts";
import {
  MockProvider,
  text,
  thinking,
  toolUse,
  type ScriptedTurn,
} from "./mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

/**
 * Parent and child share one provider, so the script interleaves: the child's
 * requests happen *inside* the parent's task call, exactly as in production.
 */
function setup(script: ScriptedTurn[]) {
  const provider = new MockProvider(script);
  const session = new Session({
    cwd: dir,
    config: defaultConfig(),
    provider,
    projectDir: dir,
  });
  return { provider, session, registry: makeRegistry(builtinTools) };
}

async function collect(
  gen: AsyncGenerator<LoopEvent, void, undefined>,
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const results = (content: ContentBlock[]): ToolResultBlock[] =>
  content.filter((b): b is ToolResultBlock => b.type === "tool_result");

const spawn = (input: Record<string, unknown>): ScriptedTurn => ({
  content: [toolUse("t1", "task", { description: "sub work", ...input })],
  stopReason: "tool_use",
});

describe("sub-agents", () => {
  test("the child's report comes back as the tool result; its transcript does not", async () => {
    const { provider, session, registry } = setup([
      spawn({ prompt: "count the widgets" }),                       // parent, turn 1
      { content: [text("CHILD REPORT: 42 widgets")], stopReason: "end_turn" }, // child
      { content: [text("done")], stopReason: "end_turn" },          // parent, turn 2
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    const [r] = results(session.messages[2]!.content);
    expect(r!.is_error).toBe(false);
    expect(r!.content).toBe("CHILD REPORT: 42 widgets");
    // The parent transcript holds the report, never the child's own messages.
    expect(session.messages).toHaveLength(4);
    expect(provider.callCount).toBe(3);
  });

  test("the child starts fresh: no parent conversation in its request", async () => {
    const { provider, session, registry } = setup([
      spawn({ prompt: "the complete brief" }),
      { content: [text("ok")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    await collect(runTurn(session, "parent secret", { registry }, new AbortController().signal));

    const childReq = provider.requests[1]!;
    expect(childReq.messages).toHaveLength(1);
    expect(JSON.stringify(childReq.messages)).toContain("the complete brief");
    expect(JSON.stringify(childReq.messages)).not.toContain("parent secret");
  });

  test("the child cannot spawn: its toolset has no task", async () => {
    const { provider, session, registry } = setup([
      spawn({ prompt: "p" }),
      { content: [text("ok")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    const childTools = provider.requests[1]!.tools.map((t) => t.name);
    expect(childTools).not.toContain("task");
    expect(childTools).toContain("bash");
  });

  test("readOnly: true strips every mutating tool from the child", async () => {
    const { provider, session, registry } = setup([
      spawn({ prompt: "p", readOnly: true }),
      { content: [text("ok")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    const childTools = provider.requests[1]!.tools.map((t) => t.name);
    // todo_write is readOnly on purpose: an exploring child may keep a plan.
    expect(childTools.sort()).toEqual(["glob", "grep", "read_file", "todo_write"]);
  });

  test("the child's spend lands in the parent's totals", async () => {
    const { session, registry } = setup([
      { ...spawn({ prompt: "p" }), usage: { inputTokens: 10, outputTokens: 5 } },
      {
        content: [text("ok")],
        stopReason: "end_turn",
        usage: { inputTokens: 700, outputTokens: 300 },
      },
      {
        content: [text("done")],
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 5 },
      },
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    expect(session.totalUsage.inputTokens).toBe(730);
    expect(session.totalUsage.outputTokens).toBe(310);
  });

  test("a child that exhausts its iterations reports incomplete, not done", async () => {
    // The child (30-iteration cap) never stops calling tools. Its partial
    // prose must come back as an *error* carrying the partial report — a
    // capped sub-agent once reported as a complete success.
    const childTurns: ScriptedTurn[] = Array.from({ length: 30 }, () => ({
      content: [text("digging… "), toolUse("c", "glob", { pattern: "*.ts" })],
      stopReason: "tool_use" as const,
    }));
    const { session, registry } = setup([
      spawn({ prompt: "impossible quest" }),
      ...childTurns,
      { content: [text("noted")], stopReason: "end_turn" }, // parent reacts
    ]);

    await collect(runTurn(session, "go", { registry }, new AbortController().signal));

    const [r] = results(session.messages[2]!.content);
    expect(r!.is_error).toBe(true);
    expect(r!.content).toContain("stopped before finishing");
    expect(r!.content).toContain("digging…");
  });

  test("a child stonewalled by permissions reports incomplete too", async () => {
    const { session, registry } = setup([
      spawn({ prompt: "p" }),
      // Two fully-denied child turns trip the denied-streak guard.
      {
        content: [toolUse("c1", "write_file", { path: "x", content: "1" })],
        stopReason: "tool_use",
      },
      {
        content: [toolUse("c2", "write_file", { path: "x", content: "1" })],
        stopReason: "tool_use",
      },
      { content: [text("noted")], stopReason: "end_turn" }, // parent reacts
    ]);

    await collect(
      runTurn(
        session,
        "go",
        {
          registry,
          approve: async (tool) =>
            tool.name === "write_file"
              ? { allow: false, reason: "not allowed" }
              : { allow: true },
        },
        new AbortController().signal,
      ),
    );

    const [r] = results(session.messages[2]!.content);
    expect(r!.is_error).toBe(true);
    expect(r!.content).toContain("stopped before finishing");
  });

  test("the child's tool calls face the same permission gate", async () => {
    const { session, registry } = setup([
      spawn({ prompt: "p" }),
      // The child tries to write; the shared gate refuses it.
      {
        content: [toolUse("c1", "write_file", { path: "x.ts", content: "boom" })],
        stopReason: "tool_use",
      },
      { content: [text("could not write")], stopReason: "end_turn" }, // child reacts
      { content: [text("done")], stopReason: "end_turn" },            // parent
    ]);

    const gated: string[] = [];
    await collect(
      runTurn(
        session,
        "go",
        {
          registry,
          approve: async (tool) => {
            gated.push(tool.name);
            return tool.name === "write_file"
              ? { allow: false, reason: "not on my watch" }
              : { allow: true };
          },
        },
        new AbortController().signal,
      ),
    );

    // Gate saw the parent's task call AND the child's write.
    expect(gated).toEqual(["task", "write_file"]);
  });
});

describe("sub-agent event forwarding", () => {
  const childGlob: ScriptedTurn = {
    content: [toolUse("c1", "glob", { pattern: "*.ts" })],
    stopReason: "tool_use",
  };

  test("sub-agent tool_start events are forwarded to the parent loop with depth: 1", async () => {
    const { session, registry } = setup([
      spawn({ prompt: "look around" }),
      childGlob,
      { content: [text("CHILD REPORT")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const child = events.filter((e) => e.depth === 1);
    expect(child.map((e) => e.type)).toEqual([
      "tool_start",
      "tool_end",
      "text_delta",
      "turn_end",
    ]);
    const start = child.find((e) => e.type === "tool_start");
    expect(start?.type === "tool_start" && start.name).toBe("glob");
    // The parent's own events stay at depth 0 (i.e. untagged).
    const parent = events.filter((e) => e.depth !== 1);
    expect(parent.every((e) => e.depth === undefined)).toBe(true);
    expect(parent.map((e) => e.type)).toEqual([
      "tool_start",
      "tool_end",
      "text_delta",
      "turn_end",
    ]);
  });

  test("sub-agent events are emitted between the parent's tool_start and tool_end", async () => {
    const { session, registry } = setup([
      spawn({ prompt: "look around" }),
      childGlob,
      { content: [text("CHILD REPORT")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    expect(events.map((e) => ({ type: e.type, depth: e.depth }))).toEqual([
      { type: "tool_start", depth: undefined }, // parent: task(…)
      { type: "tool_start", depth: 1 }, //         child: glob
      { type: "tool_end", depth: 1 },
      { type: "text_delta", depth: 1 }, //         child: its report
      { type: "turn_end", depth: 1 },
      { type: "tool_end", depth: undefined }, //   parent: the report lands
      { type: "text_delta", depth: undefined },
      { type: "turn_end", depth: undefined },
    ]);
  });

  test("a child that emits thinking_delta also forwards it with depth: 1", async () => {
    const { session, registry } = setup([
      spawn({ prompt: "think it over" }),
      {
        content: [thinking("weighing the options"), text("CHILD REPORT")],
        stopReason: "end_turn",
      },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const thought = events.find((e) => e.type === "thinking_delta");
    expect(thought).toBeDefined();
    expect(thought?.depth).toBe(1);
    expect(thought?.type === "thinking_delta" && thought.text).toBe("weighing the options");
  });

  test("every event of a busy child is tagged, and the outcome is unaffected", async () => {
    const busy: ScriptedTurn[] = Array.from({ length: 3 }, (_, i) => ({
      content: [toolUse(`c${i}`, "glob", { pattern: "*.ts" })],
      stopReason: "tool_use" as const,
    }));
    const { session, registry } = setup([
      spawn({ prompt: "dig" }),
      ...busy,
      { content: [text("CHILD REPORT: 3 looks")], stopReason: "end_turn" },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const events = await collect(
      runTurn(session, "go", { registry }, new AbortController().signal),
    );

    const child = events.filter((e) => e.depth === 1);
    expect(child.filter((e) => e.type === "tool_start")).toHaveLength(3);
    expect(child.filter((e) => e.type === "tool_end")).toHaveLength(3);
    expect(child.every((e) => e.depth === 1)).toBe(true);
    // Forwarding is a tee: the tool result is still just the child's report.
    const [r] = results(session.messages[2]!.content);
    expect(r!.is_error).toBe(false);
    expect(r!.content).toBe("CHILD REPORT: 3 looks");
  });
});
