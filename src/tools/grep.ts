import { z } from "zod";
import { resolvePath } from "../core/paths.ts";
import {
  fail,
  jsonSchemaOf,
  ok,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.ts";

const schema = z.object({
  pattern: z.string().min(1).describe("Regular expression (Rust regex syntax)."),
  path: z.string().optional().describe("File or directory to search. Defaults to cwd."),
  glob: z
    .array(z.string())
    .optional()
    .describe('Glob filters, e.g. ["*.ts", "!*.test.ts"].'),
  case_insensitive: z.boolean().optional().describe("Case-insensitive match."),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context around each match."),
  max_results: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum matching lines to return. Defaults to 100."),
  files_only: z
    .boolean()
    .optional()
    .describe("Return only the list of matching file paths."),
});

type Input = z.infer<typeof schema>;

export function buildRgArgs(input: Input, target: string): string[] {
  const args = ["--color", "never", "--no-heading", "--line-number", "--with-filename"];
  if (input.case_insensitive) args.push("--ignore-case");
  if (input.files_only) {
    args.length = 0;
    args.push("--color", "never", "--files-with-matches");
  } else if (input.context_lines) {
    args.push("--context", String(input.context_lines));
  }
  for (const g of input.glob ?? []) args.push("--glob", g);
  args.push("--max-columns", "400", "--max-columns-preview");
  args.push("--regexp", input.pattern, "--", target);
  return args;
}

export const grepTool: Tool<Input> = {
  name: "grep",
  description: [
    "Search file contents with ripgrep. Respects .gitignore.",
    "Prefer this over `bash grep` or `bash find`: it is faster and its output",
    "is bounded. Use `files_only` when you only need to know which files match.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: true,

  summarize: (input) =>
    `"${input.pattern}"${input.path ? ` in ${input.path}` : ""}${
      input.glob?.length ? ` (${input.glob.join(", ")})` : ""
    }`,

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const target = resolvePath(ctx.cwd, input.path ?? ".");
    const args = buildRgArgs(input, target);

    let proc;
    try {
      proc = Bun.spawn(["rg", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd: ctx.cwd,
      });
    } catch {
      return fail(
        "ripgrep (`rg`) is not installed or not on PATH. Install it, or fall " +
          "back to `bash` with grep/find for this search.",
      );
    }

    const onAbort = () => proc.kill("SIGTERM");
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    let stdout: string;
    let stderr: string;
    let code: number;
    try {
      [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
    }

    if (ctx.signal.aborted) return fail("Search was interrupted by the user.");

    // rg: 0 = matches, 1 = no matches (not an error), 2 = real failure.
    if (code === 1) return ok(`No matches for /${input.pattern}/.`);
    if (code !== 0) {
      return fail(`ripgrep failed (exit ${code}): ${stderr.trim() || "unknown error"}`);
    }

    const lines = stdout.split("\n").filter(Boolean);
    const limit = input.max_results ?? 100;
    const shown = lines.slice(0, limit);
    const rel = shown.map((l) => stripCwd(l, ctx.cwd));

    const header = input.files_only
      ? `${lines.length} file(s) matched`
      : `${lines.length} matching line(s)`;
    const overflow =
      lines.length > limit
        ? `\n\n… ${lines.length - limit} more. Narrow the pattern or raise max_results.`
        : "";

    // Size is capped centrally, in core/hygiene.ts.
    return ok(`${header}\n\n${rel.join("\n")}${overflow}`, { total: lines.length });
  },
};

/** rg prints absolute paths when given an absolute target; shorten for the model. */
function stripCwd(line: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}
