import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileTool } from "../../src/tools/read_file.ts";
import { writeFileTool } from "../../src/tools/write_file.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
let ctx: ReturnType<typeof makeCtx>;

beforeEach(() => {
  dir = tempDir();
  ctx = makeCtx(dir);
});
afterEach(() => cleanup(dir));

const write = (name: string, content: string | Buffer) =>
  writeFileSync(join(dir, name), content);

describe("read_file", () => {
  test("returns 1-indexed, tab-separated numbered lines", async () => {
    write("a.txt", "first\nsecond\nthird\n");
    const r = await readFileTool.run({ path: "a.txt" }, ctx);

    expect(r.isError).toBe(false);
    expect(r.output).toContain("1\tfirst");
    expect(r.output).toContain("3\tthird");
    expect(r.output).toContain("lines 1-3 of 3");
  });

  test("does not count a trailing newline as an extra line", async () => {
    write("a.txt", "only\n");
    const r = await readFileTool.run({ path: "a.txt" }, ctx);
    expect(r.output).toContain("of 1");
    expect(r.output).not.toContain("2\t");
  });

  test("offset and limit page through a file and advertise the next call", async () => {
    write("a.txt", Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const r = await readFileTool.run({ path: "a.txt", offset: 3, limit: 2 }, ctx);

    expect(r.output).toContain("3\tL3");
    expect(r.output).toContain("4\tL4");
    expect(r.output).not.toContain("5\tL5");
    expect(r.output).toContain("6 more lines");
    expect(r.output).toContain("offset=5");
  });

  test("byte budget truncates and still offers a continuation", async () => {
    write("big.txt", `${"x".repeat(100)}\n`.repeat(200));
    ctx.config.maxFileReadBytes = 500;
    const r = await readFileTool.run({ path: "big.txt" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("more lines");
  });

  test("missing file", async () => {
    const r = await readFileTool.run({ path: "nope.txt" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("File not found");
  });

  test("directory", async () => {
    const r = await readFileTool.run({ path: "." }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("is a directory");
  });

  test("binary file is refused, not garbled", async () => {
    write("bin", Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const r = await readFileTool.run({ path: "bin" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("binary");
  });

  test("offset past EOF is an error, not empty output", async () => {
    write("a.txt", "one\n");
    const r = await readFileTool.run({ path: "a.txt", offset: 99 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("past the end");
  });

  test("empty file", async () => {
    write("empty.txt", "");
    const r = await readFileTool.run({ path: "empty.txt" }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toContain("is empty");
  });
});

describe("write_file", () => {
  test("creates a file and its parent directories", async () => {
    const r = await writeFileTool.run(
      { path: "nested/deep/a.txt", content: "hi\n" },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.output).toContain("Created");
    expect(readFileSync(join(dir, "nested/deep/a.txt"), "utf8")).toBe("hi\n");
  });

  test("refuses to clobber an existing file", async () => {
    write("a.txt", "original\n");
    const r = await writeFileTool.run({ path: "a.txt", content: "new" }, ctx);

    expect(r.isError).toBe(true);
    expect(r.output).toContain("already exists");
    expect(r.output).toContain("overwrite: true");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("original\n");
  });

  test("overwrite: true replaces the file", async () => {
    write("a.txt", "original\n");
    const r = await writeFileTool.run(
      { path: "a.txt", content: "new\n", overwrite: true },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.output).toContain("Overwrote");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n");
  });

  test("write into an unwritable directory reports the OS error", async () => {
    const r = await writeFileTool.run({ path: "/proc/x/y.txt", content: "z" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.output).toContain("Cannot write");
    expect(existsSync("/proc/x/y.txt")).toBe(false);
  });
});
