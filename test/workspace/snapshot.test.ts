import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "../helpers.ts";
import {
  SnapshotError,
  createWorkspaceSnapshot,
  extractSnapshot,
  snapshotExclusion,
} from "../../src/workspace/snapshot.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("workspace snapshots", () => {
  test("includes tracked and non-ignored untracked files but excludes secrets and internals", () => {
    git("init", "--quiet");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "tracked.ts"), "export const n = 1;\n");
    git("add", ".gitignore", "tracked.ts");
    writeFileSync(join(dir, "untracked.md"), "hello\n");
    writeFileSync(join(dir, "ignored.txt"), "ignored\n");
    writeFileSync(join(dir, ".env.production"), "TOKEN=secret\n");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "nope\n");
    symlinkSync("tracked.ts", join(dir, "linked.ts"));

    const snapshot = createWorkspaceSnapshot(dir, { persist: false });
    expect(snapshot.files).toEqual([".gitignore", "tracked.ts", "untracked.md"]);
    expect(snapshot.manifest["tracked.ts"]).toHaveLength(64);
    expect(Buffer.from(snapshot.archive).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  test("extracts the sanitized archive byte-for-byte", () => {
    writeFileSync(join(dir, "hello.txt"), "hello\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    const snapshot = createWorkspaceSnapshot(dir, { persist: false });
    const output = tempDir();
    try {
      expect(extractSnapshot(snapshot.archive, output)).toEqual(["hello.txt", "src/index.ts"]);
      expect(readFileSync(join(output, "src", "index.ts"), "utf8")).toBe("export {};\n");
    } finally {
      cleanup(output);
    }
  });

  test("round-trips ustar paths longer than the name field", () => {
    const nested = join(dir, "a".repeat(70), "b".repeat(50));
    mkdirSync(nested, { recursive: true });
    const relative = `${"a".repeat(70)}/${"b".repeat(50)}/file.txt`;
    writeFileSync(join(dir, relative), "long path\n");
    const snapshot = createWorkspaceSnapshot(dir, { persist: false });
    const output = tempDir();
    try {
      expect(extractSnapshot(snapshot.archive, output)).toContain(relative);
      expect(readFileSync(join(output, relative), "utf8")).toBe("long path\n");
    } finally {
      cleanup(output);
    }
  });

  test("rejects snapshots over the configured limit", () => {
    writeFileSync(join(dir, "large.bin"), Buffer.alloc(64));
    expect(() => createWorkspaceSnapshot(dir, { maxBytes: 32, persist: false })).toThrow(SnapshotError);
    expect(() => createWorkspaceSnapshot(dir, { maxBytes: 32, persist: false })).toThrow(/limit/);
  });

  test("configured secret patterns are matched without exposing file contents", () => {
    expect(snapshotExclusion("config/prod.secret.json", ["**/*.secret.json"])).toBe("configured secret pattern");
    expect(snapshotExclusion("src/public.json", ["**/*.secret.json"])).toBeUndefined();
  });
});
