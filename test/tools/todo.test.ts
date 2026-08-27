import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config/schema.ts";
import { runTurn } from "../../src/core/loop.ts";
import { Session } from "../../src/core/session.ts";
import type { TodoItem } from "../../src/core/types.ts";
import { builtinTools, makeRegistry } from "../../src/tools/index.ts";
import { todoTool } from "../../src/tools/todo.ts";
import { erase } from "../../src/tools/types.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";
import { MockProvider, text, toolUse } from "../mock_provider.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const todo = erase(todoTool);

const item = (content: string, status: TodoItem["status"]): TodoItem => ({
  content,
  status,
});

function recordingCtx() {
  const lists: TodoItem[][] = [];
  const ctx = makeCtx(dir, { setTodos: (items) => lists.push(items) });
  return { ctx, lists };
}

describe("todo_write", () => {
  test("replaces the list wholesale and confirms in one line", async () => {
    const { ctx, lists } = recordingCtx();
    const todos = [
      item("read the code", "completed"),
      item("write the fix", "in_progress"),
      item("run the tests", "pending"),
    ];
    const result = await todo.run({ todos }, ctx);

    expect(result.isError).toBe(false);
    expect(lists).toEqual([todos]);
    // One line for the model; the full list rides in meta for the TUI only.
    expect(result.output).toBe("Todo list updated: 1/3 done; in progress: write the fix");
    expect(result.meta?.["todos"]).toEqual(todos);
  });

  test("two in_progress items are rejected at the boundary, fixably", async () => {
    const { ctx, lists } = recordingCtx();
    const result = await todo.run(
      { todos: [item("a", "in_progress"), item("b", "in_progress")] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("at most one todo may be in_progress");
    expect(lists).toHaveLength(0); // the bad list never landed
  });

  test("an empty list is rejected — re-plan by rewriting, not by clearing", async () => {
    const { ctx } = recordingCtx();
    const result = await todo.run({ todos: [] }, ctx);
    expect(result.isError).toBe(true);
  });

  test("summarize names the active item; a finished list shows the score", () => {
    expect(
      todo.summarize({ todos: [item("a", "completed"), item("b", "in_progress")] }),
    ).toBe("b");
    expect(
      todo.summarize({ todos: [item("a", "completed"), item("b", "completed")] }),
    ).toBe("2/2 done");
  });

  test("without a session to hold the list, the tool says so", async () => {
    const result = await todo.run({ todos: [item("a", "pending")] }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not available");
  });

  test("it is free: readOnly, so no permission prompt and fine in plan mode", () => {
    expect(todo.readOnly).toBe(true);
  });

  test("through the loop, the list lands on the Session", async () => {
    const todos = [item("explore", "completed"), item("fix", "in_progress")];
    const provider = new MockProvider([
      { content: [toolUse("t1", "todo_write", { todos })], stopReason: "tool_use" },
      { content: [text("on it")], stopReason: "end_turn" },
    ]);
    const session = new Session({
      cwd: dir,
      config: defaultConfig(),
      provider,
      projectDir: dir,
    });

    for await (const _ of runTurn(
      session,
      "go",
      { registry: makeRegistry(builtinTools) },
      new AbortController().signal,
    )) {
      // drain
    }

    expect(session.todos).toEqual(todos);
  });
});
