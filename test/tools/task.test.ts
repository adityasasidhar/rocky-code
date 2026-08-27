import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { taskTool } from "../../src/tools/task.ts";
import { erase, type AgentOutcome, type AgentRequest } from "../../src/tools/types.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const task = erase(taskTool);

const outcome = (over: Partial<AgentOutcome> = {}): AgentOutcome => ({
  answer: "the report",
  toolCalls: 3,
  turns: 2,
  incomplete: false,
  ...over,
});

/** ctx whose runAgent is a recording fake — the tool is pure over it. */
function agentCtx(result: AgentOutcome = outcome()) {
  const calls: AgentRequest[] = [];
  const ctx = makeCtx(dir, {
    runAgent: async (req) => {
      calls.push(req);
      return result;
    },
  });
  return { ctx, calls };
}

describe("task tool", () => {
  test("passes prompt and readOnly through, returns the child's report", async () => {
    const { ctx, calls } = agentCtx();
    const result = await task.run(
      { description: "explore auth", prompt: "map the auth flow", readOnly: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe("the report");
    expect(calls).toEqual([{ prompt: "map the auth flow", readOnly: true }]);
  });

  test("readOnly defaults to false", async () => {
    const { ctx, calls } = agentCtx();
    await task.run({ description: "d", prompt: "p" }, ctx);
    expect(calls[0]?.readOnly).toBe(false);
  });

  test("without runAgent the tool refuses — sub-agents do not nest", async () => {
    const result = await task.run({ description: "d", prompt: "p" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot spawn sub-agents");
  });

  test("an interrupted child is an error carrying the partial report", async () => {
    const { ctx } = agentCtx(outcome({ incomplete: true, answer: "half done" }));
    const result = await task.run({ description: "d", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("half done");
  });

  test("a child that says nothing is an error, not a silent empty result", async () => {
    const { ctx } = agentCtx(outcome({ answer: "" }));
    const result = await task.run({ description: "d", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("without producing a report");
  });

  test("malformed input fails at the boundary", async () => {
    const { ctx, calls } = agentCtx();
    const result = await task.run({ description: "d" }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("the summary is the human description; the preview is the child's brief", () => {
    expect(task.summarize({ description: "explore auth", prompt: "p" })).toBe(
      "explore auth",
    );
    const preview = task.preview(
      { description: "d", prompt: "full instructions", readOnly: true },
      makeCtx(dir),
    );
    expect(preview).toContain("full instructions");
    expect(preview).toContain("read-only");
  });
});
