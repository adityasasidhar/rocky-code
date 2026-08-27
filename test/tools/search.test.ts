import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globTool } from "../../src/tools/glob.ts";
import { buildRgArgs, grepTool } from "../../src/tools/grep.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
let ctx: ReturnType<typeof makeCtx>;

const write = (rel: string, content: string, mtime?: number) => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  if (mtime) utimesSync(p, mtime / 1000, mtime / 1000);
};

beforeEach(() => {
  dir = tempDir();
  ctx = makeCtx(dir);
});
afterEach(() => cleanup(dir));

describe("buildRgArgs", () => {
  test("passes globs and case-insensitivity through", () => {
    const args = buildRgArgs(
      { pattern: "foo", glob: ["*.ts", "!*.test.ts"], case_insensitive: true },
      "/tmp",
    );
    expect(args).toContain("--ignore-case");
    expect(args).toContain("*.ts");
    expect(args).toContain("!*.test.ts");
    expect(args.at(-1)).toBe("/tmp");
  });

  test("files_only drops line formatting flags", () => {
    const args = buildRgArgs({ pattern: "foo", files_only: true }, "/tmp");
    expect(args).toContain("--files-with-matches");
    expect(args).not.toContain("--line-number");
  });

  test("context_lines is forwarded", () => {
    const args = buildRgArgs({ pattern: "foo", context_lines: 2 }, "/tmp");
    expect(args).toContain("--context");
    expect(args).toContain("2");
  });
});

describe("grep", () => {
  test("finds matches and reports paths relative to cwd", async () => {
    write("src/a.ts", "const needle = 1;\n");
    write("src/b.ts", "nothing here\n");

    const r = await grepTool.run({ pattern: "needle" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("src/a.ts");
    expect(r.output).not.toContain(dir);
    expect(r.output).toContain("1 matching line");
  });

  test("no matches is a success, not an error", async () => {
    write("a.ts", "hello\n");
    const r = await grepTool.run({ pattern: "zzz_absent" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("No matches");
  });

  test("glob filter narrows the search", async () => {
    write("a.ts", "needle\n");
    write("a.md", "needle\n");

    const r = await grepTool.run({ pattern: "needle", glob: ["*.md"] }, ctx);
    expect(r.output).toContain("a.md");
    expect(r.output).not.toContain("a.ts");
  });

  test("files_only lists paths without line numbers", async () => {
    write("a.ts", "needle\nneedle\n");
    const r = await grepTool.run({ pattern: "needle", files_only: true }, ctx);
    expect(r.output).toContain("1 file(s) matched");
    expect(r.output).not.toContain(":1:");
  });

  test("max_results caps output and says how much was dropped", async () => {
    write("a.ts", "needle\n".repeat(50));
    const r = await grepTool.run({ pattern: "needle", max_results: 5 }, ctx);
    expect(r.output).toContain("50 matching line(s)");
    expect(r.output).toContain("45 more");
  });

  test("an invalid regex surfaces ripgrep's error", async () => {
    write("a.ts", "x\n");
    const r = await grepTool.run({ pattern: "(unclosed" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("ripgrep failed");
  });
});

describe("glob", () => {
  test("lists matching files newest first", async () => {
    const now = Date.now();
    write("old.ts", "1", now - 100_000);
    write("new.ts", "2", now);

    const r = await globTool.run({ pattern: "*.ts" }, ctx);
    expect(r.isError).toBe(false);
    const lines = r.output.split("\n").filter((l) => l.endsWith(".ts"));
    expect(lines[0]).toBe("new.ts");
    expect(lines[1]).toBe("old.ts");
  });

  test("recursive patterns work and node_modules is skipped", async () => {
    write("src/deep/a.ts", "1");
    write("node_modules/pkg/b.ts", "2");

    const r = await globTool.run({ pattern: "**/*.ts" }, ctx);
    expect(r.output).toContain("src/deep/a.ts");
    expect(r.output).not.toContain("node_modules");
  });

  test("no matches is a success", async () => {
    const r = await globTool.run({ pattern: "*.nothing" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("No files match");
  });

  test("max_results caps the listing", async () => {
    for (let i = 0; i < 10; i++) write(`f${i}.ts`, "x");
    const r = await globTool.run({ pattern: "*.ts", max_results: 3 }, ctx);
    expect(r.output).toContain("10 file(s)");
    expect(r.output).toContain("7 more");
  });
});
