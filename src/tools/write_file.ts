import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { diffLines, formatDiff } from "../core/diff.ts";
import { displayPath, resolvePath } from "../core/paths.ts";
import {
  fail,
  jsonSchemaOf,
  ok,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.ts";

const schema = z.object({
  path: z.string().min(1).describe("Path to write. Parent directories are created."),
  content: z.string().describe("Full file contents."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Must be true to replace an existing file. Defaults to false."),
});

type Input = z.infer<typeof schema>;

export const writeFileTool: Tool<Input> = {
  name: "write_file",
  description: [
    "Create a new file with the given contents.",
    "Refuses to replace an existing file unless `overwrite` is true —",
    "read the file first, then prefer edit_file for changes to existing files.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: false,

  summarize: (input) =>
    `${input.path} (${input.content.split("\n").length} lines)${
      input.overwrite ? " [overwrite]" : ""
    }`,

  /** For a new file, every line is an addition; for an overwrite, show the diff. */
  preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    if (!before) {
      const lines = input.content.split("\n");
      const shown = lines.slice(0, 40).map((l) => `+ ${l}`);
      if (lines.length > 40) shown.push(`… ${lines.length - 40} more lines`);
      return shown.join("\n");
    }
    return formatDiff(diffLines(before.split("\n"), input.content.split("\n")), 3);
  },

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx.cwd, input.path);
    const rel = displayPath(ctx.cwd, abs);
    const exists = existsSync(abs);

    if (exists && !input.overwrite) {
      let hint = "";
      try {
        const current = readFileSync(abs, "utf8");
        hint = ` It currently has ${current.split("\n").length} lines.`;
      } catch {
        // Unreadable but present — the refusal still stands.
      }
      return fail(
        `${rel} already exists.${hint} Read it first, then either use edit_file ` +
          `for a targeted change, or call write_file again with overwrite: true.`,
      );
    }

    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, input.content, "utf8");
    } catch (e) {
      return fail(`Cannot write ${rel}: ${(e as Error).message}`);
    }

    const lines = input.content.split("\n").length;
    return ok(`${exists ? "Overwrote" : "Created"} ${rel} (${lines} lines).`, {
      path: abs,
      created: !exists,
    });
  },
};
