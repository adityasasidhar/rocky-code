import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  loadSettings,
  persistAllow,
  settingsPath,
} from "../../src/permissions/settings.ts";
import { cleanup, tempDir } from "../helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const write = (content: string) => {
  mkdirSync(dirname(settingsPath(dir)), { recursive: true });
  writeFileSync(settingsPath(dir), content, "utf8");
};

describe("loadSettings", () => {
  test("a missing file is empty, not an error", () => {
    expect(loadSettings(dir)).toEqual({ allow: [], allowTools: [] });
  });

  test("reads both buckets", () => {
    write(JSON.stringify({ allow: ["bun test"], allowTools: ["edit_file"] }));
    expect(loadSettings(dir)).toEqual({ allow: ["bun test"], allowTools: ["edit_file"] });
  });

  test("a corrupt file degrades to empty rather than killing the session", () => {
    write("{ not json");
    expect(loadSettings(dir)).toEqual({ allow: [], allowTools: [] });
  });

  test("a schema-invalid file degrades to empty — never grants by accident", () => {
    write(JSON.stringify({ allow: "bun test" }));
    expect(loadSettings(dir)).toEqual({ allow: [], allowTools: [] });
  });

  test("missing keys default to empty", () => {
    write(JSON.stringify({ allow: ["ls"] }));
    expect(loadSettings(dir).allowTools).toEqual([]);
  });
});

describe("persistAllow", () => {
  test("creates the file and the .rocky directory", () => {
    expect(persistAllow(dir, { kind: "bash", rule: "bun test" })).toBe(true);
    expect(loadSettings(dir).allow).toEqual(["bun test"]);
  });

  test("appends without losing existing rules", () => {
    persistAllow(dir, { kind: "bash", rule: "bun test" });
    persistAllow(dir, { kind: "bash", rule: "git status" });
    expect(loadSettings(dir).allow).toEqual(["bun test", "git status"]);
  });

  test("de-duplicates", () => {
    persistAllow(dir, { kind: "bash", rule: "ls" });
    persistAllow(dir, { kind: "bash", rule: "ls" });
    expect(loadSettings(dir).allow).toEqual(["ls"]);
  });

  test("tool grants go to their own bucket and do not disturb bash rules", () => {
    persistAllow(dir, { kind: "bash", rule: "ls" });
    persistAllow(dir, { kind: "tool", name: "edit_file" });

    const s = loadSettings(dir);
    expect(s.allow).toEqual(["ls"]);
    expect(s.allowTools).toEqual(["edit_file"]);
  });

  test("an unwritable location reports failure instead of throwing", () => {
    expect(persistAllow("/proc/nonexistent", { kind: "bash", rule: "ls" })).toBe(false);
  });
});
