import { z } from "zod";
import { fail, jsonSchemaOf, ok, type Tool, type ToolContext } from "./types.ts";

const schema = z.object({
  description: z
    .string()
    .min(1)
    .describe("3–6 words shown to the user while the sub-agent runs"),
  prompt: z
    .string()
    .min(1)
    .describe(
      "Complete instructions for the sub-agent. It starts fresh — it cannot see " +
        "this conversation, so include every path, name, and constraint it needs, " +
        "and say exactly what its report must contain.",
    ),
  readOnly: z
    .boolean()
    .default(false)
    .describe("true = the sub-agent may only read, grep, and glob: explore and report"),
});

type Input = z.infer<typeof schema>;

/**
 * Delegation, for context isolation: the child burns its own window on
 * exploration and only its final report lands in the parent's transcript.
 *
 * Deliberately not `readOnly` even though it can be told to spawn a read-only
 * child: the flag is model-supplied input, and permission tiers must not be
 * decidable by the model. The child's own tool calls go through the same
 * permission engine as the parent's, so nothing runs that the user would not
 * have been asked about.
 */
export const taskTool: Tool<Input> = {
  name: "task",
  description:
    "Run a sub-agent on a self-contained sub-task and get back only its final report. " +
    "Use it when the work would flood this conversation with intermediate output: " +
    "broad codebase exploration ('find every caller of X and how they use it'), or a " +
    "separable chunk of work with a crisp deliverable. The sub-agent has the same tools " +
    "(minus task) and starts with NO context from this conversation: its prompt must be " +
    "self-contained. Prefer readOnly: true whenever the sub-task is investigation. " +
    "Do not use it for quick single-file questions — read_file is cheaper and faster.",
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: false,
  summarize: (i) => i.description,
  preview: (i) =>
    `sub-agent${i.readOnly ? " (read-only)" : ""}:\n${i.prompt}`,

  async run(input: Input, ctx: ToolContext) {
    if (!ctx.runAgent) {
      return fail(
        "task is not available here: sub-agents cannot spawn sub-agents. " +
          "Do this work yourself with the other tools.",
      );
    }

    const outcome = await ctx.runAgent({
      prompt: input.prompt,
      readOnly: input.readOnly,
    });

    const stats = { toolCalls: outcome.toolCalls, turns: outcome.turns };
    if (outcome.incomplete) {
      return fail(
        `The sub-agent stopped before finishing (interrupted, out of iterations, ` +
          `or blocked by permissions). Partial report:\n${outcome.answer || "(nothing)"}`,
        stats,
      );
    }
    if (!outcome.answer) {
      return fail("The sub-agent finished without producing a report.", stats);
    }
    return ok(outcome.answer, stats);
  },
};
