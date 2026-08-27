import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editFileTool } from "../../src/tools/edit_file.ts";
import { erase } from "../../src/tools/types.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
let ctx: ReturnType<typeof makeCtx>;

const write = (name: string, content: string) => {
  writeFileSync(join(dir, name), content, "utf8");
  return join(dir, name);
};
const read = (name: string) => readFileSync(join(dir, name), "utf8");

beforeEach(() => {
  dir = tempDir();
  ctx = makeCtx(dir);
});
afterEach(() => cleanup(dir));

const run = (input: Parameters<typeof editFileTool.run>[0]) =>
  editFileTool.run(input, ctx);

describe("edit_file — success", () => {
  test("replaces a unique string and reports the diff", async () => {
    write("a.ts", "const x = 1;\nconst y = 2;\n");
    const r = await run({ path: "a.ts", old_str: "const x = 1;", new_str: "const x = 42;" });

    expect(r.isError).toBe(false);
    expect(read("a.ts")).toBe("const x = 42;\nconst y = 2;\n");
    expect(r.output).toContain("line 1");
    expect(r.output).toContain("+1 -1");
    expect(r.meta?.["diff"]).toContain("+ const x = 42;");
  });

  test("deletes text when new_str is empty", async () => {
    write("a.ts", "keep\ndrop\n");
    const r = await run({ path: "a.ts", old_str: "drop\n", new_str: "" });
    expect(r.isError).toBe(false);
    expect(read("a.ts")).toBe("keep\n");
  });

  test("replace_all rewrites every occurrence", async () => {
    write("a.ts", "old();\nfoo();\nold();\n");
    const r = await run({
      path: "a.ts",
      old_str: "old()",
      new_str: "renamed()",
      replace_all: true,
    });
    expect(r.isError).toBe(false);
    expect(read("a.ts")).toBe("renamed();\nfoo();\nrenamed();\n");
    expect(r.output).toContain("2 occurrence(s)");
  });

  test("preserves exact indentation", async () => {
    write("a.ts", "function f() {\n\treturn 1;\n}\n");
    await run({ path: "a.ts", old_str: "\treturn 1;", new_str: "\treturn 2;" });
    expect(read("a.ts")).toBe("function f() {\n\treturn 2;\n}\n");
  });
});

describe("edit_file — zero matches", () => {
  test("reports 0 matches and shows the closest text with a diff", async () => {
    write("a.ts", "function add(a, b) {\n  return a + b;\n}\n");
    // Model used 4-space indent; the file uses 2.
    const r = await run({
      path: "a.ts",
      old_str: "function add(a, b) {\n    return a + b;\n}",
      new_str: "function add(a, b) {\n    return a - b;\n}",
    });

    expect(r.isError).toBe(true);
    expect(r.output).toContain("0 matches");
    expect(r.output).toContain("closest text is at line 1");
    expect(r.output).toMatch(/\d+% similar/);
    // The diff must point at the whitespace difference.
    expect(r.output).toContain("+   return a + b;");
    expect(r.output).toContain("leading whitespace");
    // Nothing was written.
    expect(read("a.ts")).toBe("function add(a, b) {\n  return a + b;\n}\n");
  });

  test("calls out line-number prefixes copied from read_file", async () => {
    write("a.ts", "const x = 1;\n");
    const r = await run({ path: "a.ts", old_str: "1\tconst x = 1;", new_str: "const x = 2;" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("line-number prefixes");
  });

  test("detects a whitespace-only mismatch when nothing is similar enough", async () => {
    write("a.ts", `${"filler\n".repeat(3)}target\n`);
    const r = await run({ path: "a.ts", old_str: "   target   ", new_str: "x" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("0 matches");
  });

  test("plain miss says to re-read the file", async () => {
    write("a.ts", "alpha\n");
    const r = await run({ path: "a.ts", old_str: "zzzzzzzzzzzzzzzz", new_str: "y" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Re-read the file with read_file");
  });
});

describe("edit_file — ambiguous matches", () => {
  test("reports the count and every line number", async () => {
    write("a.ts", "dup\nother\ndup\nmore\ndup\n");
    const r = await run({ path: "a.ts", old_str: "dup", new_str: "x" });

    expect(r.isError).toBe(true);
    expect(r.output).toContain("matches 3 times");
    expect(r.output).toContain("lines 1, 3, 5");
    expect(r.output).toContain("replace_all: true");
    expect(read("a.ts")).toBe("dup\nother\ndup\nmore\ndup\n");
  });

  test("truncates the line list when there are many matches", async () => {
    write("a.ts", "dup\n".repeat(15));
    const r = await run({ path: "a.ts", old_str: "dup", new_str: "x" });
    expect(r.output).toContain("matches 15 times");
    expect(r.output).toContain("5 more");
  });
});

describe("edit_file — invalid calls", () => {
  test("missing file points at write_file", async () => {
    const r = await run({ path: "nope.ts", old_str: "a", new_str: "b" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("File not found");
    expect(r.output).toContain("write_file");
  });

  test("directory target is rejected", async () => {
    const r = await run({ path: ".", old_str: "a", new_str: "b" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("is a directory");
  });

  test("identical old_str and new_str is rejected before touching the file", async () => {
    write("a.ts", "same\n");
    const r = await run({ path: "a.ts", old_str: "same", new_str: "same" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("identical");
  });
});

describe("edit_file — multi-edit", () => {
  const erased = erase(editFileTool);

  test("several hunks land in order, atomically, as one diff", async () => {
    write("a.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const r = await run({
      path: "a.ts",
      edits: [
        { old_str: "const a = 1;", new_str: "const a = 10;" },
        { old_str: "const c = 3;", new_str: "const c = 30;" },
      ],
    });

    expect(r.isError).toBe(false);
    expect(r.output).toContain("2 edits");
    expect(read("a.ts")).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    expect(r.meta?.["diff"]).toContain("+ const a = 10;");
    expect(r.meta?.["diff"]).toContain("+ const c = 30;");
  });

  test("later hunks see earlier hunks' output — rename then use", async () => {
    write("a.ts", "function old(): number {\n  return old.length;\n}\n");
    const r = await run({
      path: "a.ts",
      edits: [
        { old_str: "function old(): number {", new_str: "function fresh(): number {" },
        // Matches only in the text hunk 1 already produced.
        { old_str: "return old.length;", new_str: "return fresh.length;" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(read("a.ts")).toBe("function fresh(): number {\n  return fresh.length;\n}\n");
  });

  test("a mid-list failure applies NOTHING and names the hunk", async () => {
    const before = "const a = 1;\nconst b = 2;\n";
    write("a.ts", before);
    const r = await run({
      path: "a.ts",
      edits: [
        { old_str: "const a = 1;", new_str: "const a = 10;" },
        { old_str: "const zzz = 9;", new_str: "const zzz = 90;" },
        { old_str: "const b = 2;", new_str: "const b = 20;" },
      ],
    });

    expect(r.isError).toBe(true);
    expect(r.output).toContain("edit 2 of 3 failed");
    expect(r.output).toContain("NOTHING was applied");
    expect(r.output).toContain("resubmit the complete list");
    // The existing diagnostics still ride along for the failing hunk.
    expect(r.output).toContain("0 matches");
    // Byte-identical: hunk 1 was valid but must not have landed.
    expect(read("a.ts")).toBe(before);
  });

  test("per-hunk replace_all; ambiguity still caught per hunk", async () => {
    write("a.ts", "x\nx\ny\ny\n");
    const all = await run({
      path: "a.ts",
      edits: [
        { old_str: "x", new_str: "X", replace_all: true },
        { old_str: "y\ny", new_str: "y" },
      ],
    });
    expect(all.isError).toBe(false);
    expect(read("a.ts")).toBe("X\nX\ny\n");

    const ambiguous = await run({
      path: "a.ts",
      edits: [{ old_str: "X", new_str: "z" }],
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.output).toContain("edit 1 of 1 failed");
    expect(ambiguous.output).toContain("2 times");
  });

  test("both forms at once, or neither, is a boundary error", async () => {
    write("a.ts", "const a = 1;\n");
    const both = await erased.run(
      {
        path: "a.ts",
        old_str: "const a = 1;",
        new_str: "const a = 2;",
        edits: [{ old_str: "const a = 1;", new_str: "const a = 3;" }],
      },
      ctx,
    );
    expect(both.isError).toBe(true);
    expect(both.output).toContain("not both");

    const neither = await erased.run({ path: "a.ts" }, ctx);
    expect(neither.isError).toBe(true);
    expect(neither.output).toContain("old_str and new_str are required");
    expect(read("a.ts")).toBe("const a = 1;\n");
  });

  test("preview shows the combined sequential result, or nothing for a doomed list", () => {
    write("a.ts", "one\ntwo\n");
    const p = editFileTool.preview!(
      {
        path: "a.ts",
        edits: [
          { old_str: "one", new_str: "uno" },
          { old_str: "uno\ntwo", new_str: "uno\ndos" },
        ],
      },
      ctx,
    );
    expect(p).toContain("+ uno");
    expect(p).toContain("+ dos");

    const doomed = editFileTool.preview!(
      { path: "a.ts", edits: [{ old_str: "missing", new_str: "x" }] },
      ctx,
    );
    expect(doomed).toBeUndefined();
  });

  test("summarize counts the hunks", () => {
    expect(
      editFileTool.summarize({
        path: "a.ts",
        edits: [
          { old_str: "1", new_str: "2" },
          { old_str: "3", new_str: "4" },
          { old_str: "5", new_str: "6" },
        ],
      }),
    ).toBe("a.ts (3 edits)");
  });
});
