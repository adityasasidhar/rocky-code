import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "../helpers.ts";
import { applyWorkspacePatch, inspectPatch, undoWorkspacePatch } from "../../src/workspace/patch.ts";
import { createWorkspaceSnapshot } from "../../src/workspace/snapshot.ts";

let dir: string;
beforeEach(() => {
  dir = tempDir();
  Bun.spawnSync(["git", "-C", dir, "init", "--quiet"]);
  writeFileSync(join(dir, "a.txt"), "before\n");
});
afterEach(() => cleanup(dir));

const PATCH = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-before
+after
`;

describe("approval-gated workspace patches", () => {
  test("refuses mutation without approval", () => {
    const snapshot = createWorkspaceSnapshot(dir);
    expect(() => applyWorkspacePatch(dir, snapshot, PATCH)).toThrow(/human approval/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("before\n");
  });

  test("checks, checkpoints, applies atomically, and undoes", () => {
    const snapshot = createWorkspaceSnapshot(dir);
    const applied = applyWorkspacePatch(dir, snapshot, PATCH, true);
    expect(applied.files).toEqual(["a.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("after\n");
    const checkpoint = undoWorkspacePatch(dir, true, applied.checkpointId);
    expect(checkpoint.files).toEqual(["a.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("before\n");
  });

  test("stale workspace hashes stop a patch before git apply", () => {
    const snapshot = createWorkspaceSnapshot(dir);
    writeFileSync(join(dir, "a.txt"), "someone else edited\n");
    expect(() => applyWorkspacePatch(dir, snapshot, PATCH, true)).toThrow(/changed since snapshot/);
  });

  test("rejects traversal, control data, binaries, and symlink changes", () => {
    expect(() => inspectPatch("--- a/../escape\n+++ b/../escape\n+x\n")).toThrow(/unsafe patch path/);
    expect(() => inspectPatch("--- /dev/null\n+++ b/.rocky/injected\n+x\n")).toThrow(/control data/);
    expect(() => inspectPatch("--- /dev/null\n+++ b/C:\\escape\n+x\n")).toThrow(/backslash/);
    expect(() => inspectPatch("diff --git a/a b/a\nGIT binary patch\nliteral 1\nA\n")).toThrow(/binary/);
    expect(() =>
      inspectPatch("diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n"),
    ).toThrow(/symlink/);
    mkdirSync(join(dir, "real"));
    symlinkSync("real", join(dir, "link"));
    const snapshot = createWorkspaceSnapshot(dir);
    const patch = "--- /dev/null\n+++ b/link/new.txt\n@@ -0,0 +1 @@\n+x\n";
    expect(() => applyWorkspacePatch(dir, snapshot, patch, true)).toThrow(/symlink/);
  });

  test("undo refuses to overwrite edits made after application", () => {
    const snapshot = createWorkspaceSnapshot(dir);
    const applied = applyWorkspacePatch(dir, snapshot, PATCH, true);
    writeFileSync(join(dir, "a.txt"), "later edit\n");
    expect(() => undoWorkspacePatch(dir, true, applied.checkpointId)).toThrow(/changed after/);
  });
});
