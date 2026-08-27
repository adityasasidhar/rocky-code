import { readFileSync, statSync } from "node:fs";
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
  path: z.string().min(1).describe("Path to the file. Absolute or relative to cwd."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-indexed line to start reading from."),
  limit: z.number().int().positive().optional().describe("How many lines to read."),
});

type Input = z.infer<typeof schema>;

const MAX_LINE = 2000;

/** Renders `   12\tcontents`, matching what the model expects from edit tooling. */
export function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((l, i) => {
      const n = String(startLine + i).padStart(width, " ");
      const body = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l;
      return `${n}\t${body}`;
    })
    .join("\n");
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const readFileTool: Tool<Input> = {
  name: "read_file",
  description: [
    "Read a file and return its contents with 1-indexed line numbers.",
    "Use `offset` and `limit` to page through large files.",
    "Line numbers are display only — never include them in edit_file arguments.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: true,

  summarize: (input) => {
    const range =
      input.offset || input.limit
        ? ` (from line ${input.offset ?? 1}${input.limit ? `, ${input.limit} lines` : ""})`
        : "";
    return `${input.path}${range}`;
  },

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx.cwd, input.path);
    const rel = displayPath(ctx.cwd, abs);

    let stat;
    try {
      stat = statSync(abs);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return fail(`File not found: ${rel}`);
      return fail(`Cannot stat ${rel}: ${err.message}`);
    }
    if (stat.isDirectory()) {
      return fail(`${rel} is a directory. Use glob or bash \`ls\` to list it.`);
    }

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      return fail(`Cannot read ${rel}: ${(e as Error).message}`);
    }
    if (looksBinary(buf)) {
      return fail(`${rel} appears to be a binary file (${stat.size} bytes).`);
    }

    const content = buf.toString("utf8");
    const allLines = content.split("\n");
    // A trailing newline yields a final "" element that is not a real line.
    if (allLines.at(-1) === "") allLines.pop();

    const offset = input.offset ?? 1;
    if (offset > allLines.length && allLines.length > 0) {
      return fail(
        `offset ${offset} is past the end of ${rel} (${allLines.length} lines).`,
      );
    }

    // Cap by both explicit limit and a byte budget, whichever binds first.
    const start = offset - 1;
    let end = input.limit ? Math.min(start + input.limit, allLines.length) : allLines.length;
    let bytes = 0;
    for (let i = start; i < end; i++) {
      bytes += Buffer.byteLength(allLines[i]!, "utf8") + 1;
      if (bytes > ctx.config.maxFileReadBytes) {
        end = i;
        break;
      }
    }

    const slice = allLines.slice(start, end);
    if (slice.length === 0) return ok(`(${rel} is empty)`);

    const body = numberLines(slice, offset);
    const shown = end - start;
    const more = allLines.length - end;
    const header = `${rel} (lines ${offset}-${offset + shown - 1} of ${allLines.length})`;
    const footer =
      more > 0
        ? `\n\n… ${more} more lines. Continue with read_file(path="${input.path}", offset=${end + 1}).`
        : "";

    return ok(`${header}\n\n${body}${footer}`, { path: abs, lines: allLines.length });
  },
};
