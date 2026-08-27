import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PermissionEngine,
  type PermissionRequest,
} from "../../src/permissions/index.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { editFileTool } from "../../src/tools/edit_file.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { readFileTool } from "../../src/tools/read_file.ts";
import { writeFileTool } from "../../src/tools/write_file.ts";
import { erase } from "../../src/tools/types.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const bash = erase(bashTool);
const edit = erase(editFileTool);
const write = erase(writeFileTool);
const read = erase(readFileTool);
const grep = erase(grepTool);

/** Plan mode's promise is that nothing prompts; asking would be a bug. */
function planEngine() {
  const asked: PermissionRequest[] = [];
  const engine = new PermissionEngine({
    mode: "plan",
    allow: [],
    deny: [],
    projectDir: dir,
    ask: async (request) => {
      asked.push(request);
      return { kind: "once" };
    },
  });
  return { engine, asked };
}

describe("plan mode", () => {
  test("read-only tools run freely", async () => {
    const { engine, asked } = planEngine();
    const ctx = makeCtx(dir);
    expect(await engine.check(read, { path: "x.ts" }, ctx)).toEqual({ allow: true });
    expect(await engine.check(grep, { pattern: "x" }, ctx)).toEqual({ allow: true });
    expect(asked).toHaveLength(0);
  });

  test("mutating tools are refused without prompting, and the reason teaches", async () => {
    const { engine, asked } = planEngine();
    const ctx = makeCtx(dir);
    for (const tool of [edit, write]) {
      const d = await engine.check(tool, { path: "x.ts" }, ctx);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toContain("plan mode");
      if (!d.allow) expect(d.reason).toContain("/plan");
    }
    // The user was never asked: plan mode refuses, it does not negotiate.
    expect(asked).toHaveLength(0);
  });

  test("bash is refused even for harmless commands — bash cannot prove itself read-only", async () => {
    const { engine } = planEngine();
    const d = await engine.check(bash, { command: "ls" }, makeCtx(dir));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("plan mode");
  });

  test("external approval gates cannot mutate while plan mode is active", async () => {
    const { engine, asked } = planEngine();
    const answer = await engine.askExternal({
      tool: { name: "workspace_apply_patch" },
      title: "apply candidate",
      onceOnly: true,
    });
    expect(answer).toMatchObject({ kind: "no" });
    if (answer.kind === "no") expect(answer.reason).toContain("plan mode");
    expect(asked).toHaveLength(0);
  });

  test("deny rules still outrank the plan-mode message", async () => {
    const { engine } = planEngine();
    const d = await engine.check(bash, { command: "rm -rf /" }, makeCtx(dir));
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("deny rule");
  });

  test("setMode lifts plan mode at runtime", async () => {
    const { engine } = planEngine();
    const ctx = makeCtx(dir);
    expect((await engine.check(edit, { path: "x" }, ctx)).allow).toBe(false);

    engine.setMode("yolo");
    expect(engine.mode).toBe("yolo");
    expect((await engine.check(edit, { path: "x" }, ctx)).allow).toBe(true);

    engine.setMode("plan");
    expect((await engine.check(edit, { path: "x" }, ctx)).allow).toBe(false);
  });
});
