import { readFileSync, statSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  diffLines,
  diffStats,
  findClosestBlock,
  formatDiff,
  occurrenceLines,
} from "../core/diff.ts";
import { displayPath, resolvePath } from "../core/paths.ts";
import {
  fail,
  jsonSchemaOf,
  ok,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.ts";

const EditSchema = z.object({
  old_str: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace, including indentation. Must appear exactly once " +
        "unless replace_all is true. Do not include line-number prefixes.",
    ),
  new_str: z.string().describe("Replacement text. Use an empty string to delete."),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring uniqueness."),
});

const schema = z
  .object({
    path: z.string().min(1).describe("Path to the file to edit."),
    old_str: EditSchema.shape.old_str.optional(),
    new_str: EditSchema.shape.new_str.optional(),
    replace_all: EditSchema.shape.replace_all,
    edits: z
      .array(EditSchema)
      .min(1)
      .optional()
      .describe(
        "Several edits to the same file, applied top to bottom in one atomic " +
          "write. Each old_str matches the file as already modified by the " +
          "previous edits. If any edit fails, nothing is written.",
      ),
  })
  // One form or the other — enforced here so a confused call comes back as a
  // fixable validation error, not as half-applied edits.
  .superRefine((v, ctx) => {
    const single = v.old_str !== undefined || v.new_str !== undefined;
    if (v.edits && single) {
      ctx.addIssue({
        code: "custom",
        message: "pass either old_str/new_str or edits, not both",
        path: ["edits"],
      });
    }
    if (!v.edits && (v.old_str === undefined || v.new_str === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "old_str and new_str are required unless `edits` is used",
        path: ["old_str"],
      });
    }
  });

type Input = z.infer<typeof schema>;
type Edit = z.infer<typeof EditSchema>;

/** Both call shapes normalize to a list; the single form is a list of one. */
const hunksOf = (input: Input): Edit[] =>
  input.edits ?? [
    {
      old_str: input.old_str!,
      new_str: input.new_str!,
      ...(input.replace_all !== undefined ? { replace_all: input.replace_all } : {}),
    },
  ];

const indent = (s: string, pad = "    ") =>
  s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

/**
 * The whole point of this tool is that a failed edit costs one turn, not three.
 * Every failure path returns enough information for the model to fix the call
 * without re-reading the file.
 */
function noMatchDiagnostic(rel: string, content: string, oldStr: string): string {
  const lines: string[] = [
    `edit_file failed: 0 matches for old_str in ${rel}.`,
    "",
  ];

  const close = findClosestBlock(content, oldStr);
  if (close) {
    const pct = Math.round(close.score * 100);
    lines.push(
      `The closest text is at line ${close.startLine} (${pct}% similar):`,
      "",
      indent(close.text),
      "",
      "Diff from your old_str (- yours, + the file's):",
      "",
      indent(formatDiff(diffLines(oldStr.split("\n"), close.text.split("\n")))),
      "",
      "Copy the file's text verbatim — check leading whitespace, tabs vs spaces,",
      "and that you did not include read_file's line-number prefixes.",
    );
  } else {
    const trimmed = oldStr.trim();
    if (trimmed !== oldStr && content.includes(trimmed)) {
      lines.push(
        "Nothing similar found, but old_str matches after trimming surrounding",
        "whitespace. Re-send old_str with the file's exact leading/trailing whitespace.",
      );
    } else {
      lines.push(
        "Nothing resembling old_str was found. Re-read the file with read_file",
        "and copy the target text exactly.",
      );
    }
  }
  return lines.join("\n");
}

function ambiguousDiagnostic(
  rel: string,
  at: number[],
  oldStr: string,
): string {
  const shown = at.slice(0, 10).join(", ");
  const more = at.length > 10 ? `, … (${at.length - 10} more)` : "";
  return [
    `edit_file failed: old_str matches ${at.length} times in ${rel} ` +
      `(lines ${shown}${more}).`,
    "",
    "old_str must identify exactly one location. Either:",
    "  1. Extend old_str with surrounding lines until it is unique, or",
    "  2. Pass replace_all: true if every occurrence should change.",
    "",
    `Your old_str was ${oldStr.split("\n").length} line(s).`,
  ].join("\n");
}

/** Apply one hunk in memory. Failure returns the model-facing diagnostic. */
function applyHunk(
  content: string,
  edit: Edit,
  rel: string,
): { updated: string; at: number[] } | { error: string } {
  if (edit.old_str === edit.new_str) {
    return { error: "edit_file failed: old_str and new_str are identical." };
  }
  const at = occurrenceLines(content, edit.old_str);
  if (at.length === 0) return { error: noMatchDiagnostic(rel, content, edit.old_str) };
  if (at.length > 1 && !edit.replace_all) {
    return { error: ambiguousDiagnostic(rel, at, edit.old_str) };
  }
  const updated = edit.replace_all
    ? content.replaceAll(edit.old_str, edit.new_str)
    : content.replace(edit.old_str, edit.new_str);
  return { updated, at };
}

export const editFileTool: Tool<Input> = {
  name: "edit_file",
  description: [
    "Replace exact strings in a file.",
    "`old_str` must match the file byte-for-byte (including indentation) and,",
    "unless `replace_all` is set, must appear exactly once.",
    "For several changes to one file, pass `edits`: they apply in order against",
    "the already-edited text, and either all land in one write or none do.",
    "On failure this tool reports how many matches it found and shows the",
    "closest text in the file, so you can correct the call immediately.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: false,

  summarize: (input) => {
    if (input.edits) return `${input.path} (${input.edits.length} edits)`;
    const n = (input.old_str ?? "").split("\n").length;
    return `${input.path} (${n} line${n === 1 ? "" : "s"}${
      input.replace_all ? ", all matches" : ""
    })`;
  },

  /** The exact diff that `run` would write. Read-only. */
  preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    const rel = displayPath(ctx.cwd, abs);
    const content = readFileSync(abs, "utf8");

    let current = content;
    for (const edit of hunksOf(input)) {
      const r = applyHunk(current, edit, rel);
      if ("error" in r) return undefined;
      current = r.updated;
    }
    return formatDiff(diffLines(content.split("\n"), current.split("\n")), 3);
  },

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const abs = resolvePath(ctx.cwd, input.path);
    const rel = displayPath(ctx.cwd, abs);
    const hunks = hunksOf(input);

    try {
      if (statSync(abs).isDirectory()) return fail(`${rel} is a directory.`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return fail(`File not found: ${rel}. Use write_file to create it.`);
      }
      return fail(`Cannot stat ${rel}: ${err.message}`);
    }

    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch (e) {
      return fail(`Cannot read ${rel}: ${(e as Error).message}`);
    }

    // All hunks apply in memory first; the file sees exactly one write, and a
    // failure anywhere means it sees none — never a half-edited file.
    let current = content;
    let lastAt: number[] = [];
    for (const [i, edit] of hunks.entries()) {
      const r = applyHunk(current, edit, rel);
      if ("error" in r) {
        return fail(
          input.edits
            ? `edit ${i + 1} of ${hunks.length} failed; NOTHING was applied to ${rel}. ` +
                `Fix this edit and resubmit the complete list.\n\n${r.error}`
            : r.error,
        );
      }
      current = r.updated;
      lastAt = r.at;
    }

    try {
      writeFileSync(abs, current, "utf8");
    } catch (e) {
      return fail(`Cannot write ${rel}: ${(e as Error).message}`);
    }

    const ops = diffLines(content.split("\n"), current.split("\n"));
    const { added, removed } = diffStats(ops);
    const where = input.edits
      ? `${hunks.length} edits`
      : input.replace_all
        ? `${lastAt.length} occurrence(s)`
        : `line ${lastAt[0]}`;

    return ok(
      `Edited ${rel} (${where}): +${added} -${removed} lines.\n\n` +
        formatDiff(ops, 2),
      { path: abs, diff: formatDiff(ops, 3), added, removed, before: content },
    );
  },
};
