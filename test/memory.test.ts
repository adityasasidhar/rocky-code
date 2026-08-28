import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectMemory, MAX_MEMORY_BYTES } from "../src/core/memory.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

describe("project memory", () => {
  test("a project with no memory file has no memory", () => {
    expect(loadProjectMemory(dir)).toBeUndefined();
  });

  test("ROCKY.md is loaded and labelled with its source", () => {
    writeFileSync(join(dir, "ROCKY.md"), "Always run bun test before finishing.");
    const seg = loadProjectMemory(dir)!;
    expect(seg).toContain('<project-memory source="ROCKY.md">');
    expect(seg).toContain("Always run bun test before finishing.");
    expect(seg).toContain("</project-memory>");
  });

  test("AGENTS.md is the fallback", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Use tabs.");
    expect(loadProjectMemory(dir)).toContain('source="AGENTS.md"');
  });

  test("ROCKY.md wins over AGENTS.md — one file, never a merge", () => {
    writeFileSync(join(dir, "ROCKY.md"), "rocky rules");
    writeFileSync(join(dir, "AGENTS.md"), "agents rules");
    const seg = loadProjectMemory(dir)!;
    expect(seg).toContain("rocky rules");
    expect(seg).not.toContain("agents rules");
  });

  test("an empty or whitespace file is treated as absent", () => {
    writeFileSync(join(dir, "ROCKY.md"), "  \n\n");
    expect(loadProjectMemory(dir)).toBeUndefined();
  });

  test("an empty ROCKY.md still lets AGENTS.md load", () => {
    writeFileSync(join(dir, "ROCKY.md"), "");
    writeFileSync(join(dir, "AGENTS.md"), "fallback");
    expect(loadProjectMemory(dir)).toContain("fallback");
  });

  test("an oversized file is truncated and says so", () => {
    writeFileSync(join(dir, "ROCKY.md"), "x".repeat(MAX_MEMORY_BYTES + 500));
    const seg = loadProjectMemory(dir)!;
    expect(Buffer.byteLength(seg, "utf8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(seg).toContain("truncated");
  });

  test("the complete wrapped segment stays within the byte cap for multibyte memory", () => {
    writeFileSync(join(dir, "ROCKY.md"), "🙂".repeat(MAX_MEMORY_BYTES));
    const seg = loadProjectMemory(dir)!;

    expect(Buffer.byteLength(seg, "utf8")).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(seg).toContain("truncated");
    expect(seg).not.toContain("�");
    expect(seg).toEndWith("</project-memory>");
  });

  test("an unreadable memory file fails loudly, not silently", () => {
    // A directory named ROCKY.md: readable-as-file it is not. Skipping it
    // would mean quietly ignoring instructions the user wrote down.
    mkdirSync(join(dir, "ROCKY.md"));
    expect(() => loadProjectMemory(dir)).toThrow(/cannot read project memory/);
  });
});
