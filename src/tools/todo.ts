import { z } from "zod";
import { fail, jsonSchemaOf, ok, type Tool, type ToolContext } from "./types.ts";

const TodoItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe("One step, a few words, imperative: 'Add the retry wrapper'"),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const schema = z
  .object({
    todos: z
      .array(TodoItemSchema)
      .min(1)
      .describe("The complete list, in order. Replaces the previous list entirely."),
  })
  // Enforced here, not in prose: a violation comes back as a validation error
  // the model fixes on the next call — the same self-correction path as every
  // other malformed input.
  .refine((v) => v.todos.filter((t) => t.status === "in_progress").length <= 1, {
    message:
      "at most one todo may be in_progress; finish or park the current one first",
    path: ["todos"],
  });

type Input = z.infer<typeof schema>;

const counts = (todos: Input["todos"]) => ({
  done: todos.filter((t) => t.status === "completed").length,
  current: todos.find((t) => t.status === "in_progress"),
});

/**
 * The agent's visible plan. Zero effect on the user's system — the whole list
 * is replaced each call and lives on the Session — so it is readOnly: it runs
 * without prompting, in parallel batches, and inside plan mode, which is
 * exactly where planning belongs.
 *
 * The model-facing output is a one-line confirmation, not an echo: the list is
 * already in the transcript as the tool_use input, and echoing it back would
 * double its token cost. The full list rides in `meta` for the TUI only.
 */
export const todoTool: Tool<Input> = {
  name: "todo_write",
  description:
    "Keep the task's todo list: pass the complete list each time, replacing the last one. " +
    "Use it for any task with three or more steps, and keep it current — exactly one item " +
    "in_progress at a time, and mark an item completed the moment it is done, not in a " +
    "batch at the end. The user watches this list to follow your progress. Re-plan by " +
    "rewriting the list; never leave it describing work you are no longer doing.",
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: true,
  summarize: (i) => {
    const { done, current } = counts(i.todos);
    return current ? current.content : `${done}/${i.todos.length} done`;
  },

  async run(input: Input, ctx: ToolContext) {
    if (!ctx.setTodos) {
      return fail("todo_write is not available here.");
    }
    ctx.setTodos(input.todos);
    const { done, current } = counts(input.todos);
    return ok(
      `Todo list updated: ${done}/${input.todos.length} done` +
        (current ? `; in progress: ${current.content}` : ""),
      { todos: input.todos },
    );
  },
};
