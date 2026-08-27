import { statSync } from "node:fs";
import { z } from "zod";
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
  pattern: z.string().min(1).describe('Glob pattern, e.g. "src/**/*.ts".'),
  path: z.string().optional().describe("Directory to search from. Defaults to cwd."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Maximum paths to return. Defaults to 200."),
});

type Input = z.infer<typeof schema>;

const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.rocky)(\/|$)/;

export const globTool: Tool<Input> = {
  name: "glob",
  description: [
    "List files matching a glob pattern, newest first (by mtime).",
    "Fast on large repos. Use it to locate files by name;",
    "use grep to search their contents.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: true,

  summarize: (input) => `${input.pattern}${input.path ? ` in ${input.path}` : ""}`,

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const root = resolvePath(ctx.cwd, input.path ?? ".");
    const limit = input.max_results ?? 200;

    let entries: { path: string; mtime: number }[];
    try {
      const glob = new Bun.Glob(input.pattern);
      entries = [];
      for await (const rel of glob.scan({
        cwd: root,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      })) {
        if (ctx.signal.aborted) return fail("Interrupted by the user.");
        if (SKIP.test(rel)) continue;
        const abs = resolvePath(root, rel);
        try {
          entries.push({ path: abs, mtime: statSync(abs).mtimeMs });
        } catch {
          // Raced with a delete; skip it.
        }
      }
    } catch (e) {
      return fail(`Invalid glob pattern "${input.pattern}": ${(e as Error).message}`);
    }

    if (entries.length === 0) return ok(`No files match ${input.pattern}.`);

    entries.sort((a, b) => b.mtime - a.mtime);
    const shown = entries.slice(0, limit).map((e) => displayPath(ctx.cwd, e.path));
    const overflow =
      entries.length > limit
        ? `\n\n… ${entries.length - limit} more. Narrow the pattern or raise max_results.`
        : "";

    return ok(
      `${entries.length} file(s), newest first:\n\n${shown.join("\n")}${overflow}`,
      { total: entries.length },
    );
  },
};
