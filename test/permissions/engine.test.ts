import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { PermissionMode } from "../../src/config/schema.ts";
import {
  loadSettings,
  PermissionEngine,
  settingsPath,
  type Answer,
  type PermissionRequest,
} from "../../src/permissions/index.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { editFileTool } from "../../src/tools/edit_file.ts";
import { readFileTool } from "../../src/tools/read_file.ts";
import { erase, type ErasedTool } from "../../src/tools/types.ts";
import { cleanup, makeCtx, tempDir } from "../helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

const bash = erase(bashTool);
const edit = erase(editFileTool);
const read = erase(readFileTool);

type Recorded = { requests: PermissionRequest[]; notices: string[] };

function engine(
  opts: {
    mode?: PermissionMode;
    allow?: string[];
    deny?: string[];
    answer?: Answer | ((r: PermissionRequest) => Answer);
  } = {},
): { engine: PermissionEngine; recorded: Recorded } {
  const recorded: Recorded = { requests: [], notices: [] };
  const answer = opts.answer ?? ({ kind: "no" } as Answer);

  return {
    recorded,
    engine: new PermissionEngine({
      mode: opts.mode ?? "ask",
      allow: opts.allow ?? [],
      deny: opts.deny ?? [],
      projectDir: dir,
      ask: async (request) => {
        recorded.requests.push(request);
        return typeof answer === "function" ? answer(request) : answer;
      },
      notify: (m) => recorded.notices.push(m),
    }),
  };
}

const check = (e: PermissionEngine, tool: ErasedTool, input: unknown) =>
  e.check(tool, input, makeCtx(dir));

const runBash = (e: PermissionEngine, command: string) => check(e, bash, { command });

describe("read-only tools", () => {
  test("never prompt, in any mode", async () => {
    const { engine: e, recorded } = engine({ mode: "ask" });
    expect(await check(e, read, { path: "x" })).toEqual({ allow: true });
    expect(recorded.requests).toHaveLength(0);
  });
});

describe("deny rules", () => {
  test("win over the allowlist", async () => {
    const { engine: e } = engine({ allow: ["rm"], deny: ["rm -rf"] });
    const d = await runBash(e, "rm -rf /tmp/x");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('deny rule "rm -rf"');
  });

  test("win over yolo — yolo means stop asking, not disable the brakes", async () => {
    const { engine: e } = engine({ mode: "yolo", deny: ["git push"] });
    expect((await runBash(e, "git push origin main")).allow).toBe(false);
    // ...but anything else in yolo runs.
    expect((await runBash(e, "curl example.com")).allow).toBe(true);
  });

  test("builtin catastrophes are refused even with an empty config", async () => {
    const { engine: e } = engine({ mode: "yolo" });
    expect((await runBash(e, "rm -rf /")).allow).toBe(false);
    expect((await runBash(e, "sudo rm -rf /")).allow).toBe(false);
  });

  test("the denial names the offending segment of a chain", async () => {
    const { engine: e } = engine({ deny: ["rm -rf"] });
    const d = await runBash(e, "bun test && rm -rf /tmp/x");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("rm -rf /tmp/x");
  });

  test("never reach the user", async () => {
    const { engine: e, recorded } = engine({ deny: ["rm -rf"] });
    await runBash(e, "rm -rf /tmp/x");
    expect(recorded.requests).toHaveLength(0);
  });
});

describe("modes", () => {
  test("ask: bash prompts", async () => {
    const { engine: e, recorded } = engine({ mode: "ask", answer: { kind: "once" } });
    expect((await runBash(e, "curl x")).allow).toBe(true);
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]!.command).toBe("curl x");
  });

  test("ask: edits prompt", async () => {
    const { engine: e, recorded } = engine({ mode: "ask", answer: { kind: "once" } });
    await check(e, edit, { path: "a.ts", old_str: "a", new_str: "b" });
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]!.tool.name).toBe("edit_file");
  });

  test("auto-edit: edits pass, bash still asks", async () => {
    const { engine: e, recorded } = engine({ mode: "auto-edit", answer: { kind: "no" } });

    expect(await check(e, edit, { path: "a.ts", old_str: "a", new_str: "b" })).toEqual({
      allow: true,
    });
    expect(recorded.requests).toHaveLength(0);

    expect((await runBash(e, "curl x")).allow).toBe(false);
    expect(recorded.requests).toHaveLength(1);
  });

  test("yolo: everything runs and the user is warned exactly once", async () => {
    const { engine: e, recorded } = engine({ mode: "yolo" });
    expect((await runBash(e, "curl x")).allow).toBe(true);
    expect((await runBash(e, "curl y")).allow).toBe(true);
    expect(recorded.requests).toHaveLength(0);
    expect(recorded.notices.filter((n) => n.includes("yolo"))).toHaveLength(1);
  });
});

describe("allow rules", () => {
  test("a configured rule skips the prompt", async () => {
    const { engine: e, recorded } = engine({ allow: ["bun test"] });
    expect((await runBash(e, "bun test src/x.ts")).allow).toBe(true);
    expect(recorded.requests).toHaveLength(0);
  });

  test("an uncovered command still prompts", async () => {
    const { engine: e, recorded } = engine({ allow: ["bun test"], answer: { kind: "no" } });
    expect((await runBash(e, "bun run build")).allow).toBe(false);
    expect(recorded.requests).toHaveLength(1);
  });

  test("a dynamic command prompts even when the allowlist covers it", async () => {
    const { engine: e, recorded } = engine({ allow: ["bun test"], answer: { kind: "no" } });
    expect((await runBash(e, "bun test $(cat payload)")).allow).toBe(false);
    expect(recorded.requests).toHaveLength(1);
  });
});

describe('answering "always" (session scope)', () => {
  test("a bash grant applies to the suggested prefix only", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "session" } });

    expect((await runBash(e, "git status --short")).allow).toBe(true);
    expect(recorded.requests).toHaveLength(1);

    // Same prefix: no second prompt.
    expect((await runBash(e, "git status")).allow).toBe(true);
    expect(recorded.requests).toHaveLength(1);

    // A sibling subcommand is NOT covered.
    expect((await runBash(e, "git push")).allow).toBe(true); // answered "session" again
    expect(recorded.requests).toHaveLength(2);
  });

  test("a compound command grants nothing, so the next identical call asks again", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "session" } });
    await runBash(e, "bun test && echo done");
    await runBash(e, "bun test && echo done");
    expect(recorded.requests).toHaveLength(2);
  });

  test("an edit grant covers the whole tool for the session", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "session" } });
    await check(e, edit, { path: "a.ts", old_str: "a", new_str: "b" });
    await check(e, edit, { path: "b.ts", old_str: "c", new_str: "d" });
    expect(recorded.requests).toHaveLength(1);
  });

  test("session grants do not touch the settings file", async () => {
    const { engine: e } = engine({ answer: { kind: "session" } });
    await runBash(e, "git status");
    expect(existsSync(settingsPath(dir))).toBe(false);
  });
});

describe('answering "persist"', () => {
  test("a bash grant is written to .rocky/settings.json as a rule", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "persist" } });
    await runBash(e, "bun test src/x.ts");

    expect(loadSettings(dir).allow).toEqual(["bun test"]);
    expect(recorded.notices.some((n) => n.includes('saved "bun test"'))).toBe(true);
  });

  test("an edit grant is written to allowTools, not the bash allowlist", async () => {
    const { engine: e } = engine({ answer: { kind: "persist" } });
    await check(e, edit, { path: "a.ts", old_str: "a", new_str: "b" });

    const settings = loadSettings(dir);
    expect(settings.allowTools).toEqual(["edit_file"]);
    expect(settings.allow).toEqual([]);
  });

  test("a command too broad to summarize is granted for the session only", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "persist" } });
    await runBash(e, "bun test && echo done");

    expect(existsSync(settingsPath(dir))).toBe(false);
    expect(recorded.notices.some((n) => n.includes("too broad"))).toBe(true);
  });

  test("persisted rules are honoured by the next session", async () => {
    const first = engine({ answer: { kind: "persist" } });
    await runBash(first.engine, "bun test");

    const second = engine({ answer: { kind: "no" } });
    expect((await runBash(second.engine, "bun test src/x")).allow).toBe(true);
    expect(second.recorded.requests).toHaveLength(0);
  });

  test("persisted tool grants are honoured by the next session", async () => {
    const first = engine({ answer: { kind: "persist" } });
    await check(first.engine, edit, { path: "a.ts", old_str: "a", new_str: "b" });

    const second = engine({ answer: { kind: "no" } });
    expect(
      (await check(second.engine, edit, { path: "z.ts", old_str: "a", new_str: "b" })).allow,
    ).toBe(true);
    expect(second.recorded.requests).toHaveLength(0);
  });

  test("the settings file is valid JSON with sorted, de-duplicated rules", async () => {
    const { engine: e } = engine({ answer: { kind: "persist" } });
    await runBash(e, "zsh --version");
    await runBash(e, "bun test");
    await runBash(e, "bun test again");

    const raw = JSON.parse(readFileSync(settingsPath(dir), "utf8")) as {
      allow: string[];
    };
    expect(raw.allow).toEqual(["bun test", "zsh"]);
  });
});

describe("denial reasons", () => {
  test('answering "no" produces a reason the model can act on', async () => {
    const { engine: e } = engine({ answer: { kind: "no" } });
    const d = await runBash(e, "curl x");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("declined");
  });

  test("a custom reason is passed through", async () => {
    const { engine: e } = engine({ answer: { kind: "no", reason: "use the test script" } });
    const d = await runBash(e, "curl x");
    if (!d.allow) expect(d.reason).toBe("use the test script");
  });
});

describe("describe()", () => {
  test("reports the mode plus config, persisted, and session rules", async () => {
    const { engine: e } = engine({
      mode: "ask",
      allow: ["bun test"],
      deny: ["curl"],
      answer: { kind: "session" },
    });
    await runBash(e, "git status");

    const d = e.describe();
    expect(d.mode).toBe("ask");
    expect(d.allow).toContain("bun test");
    expect(d.allow).toContain("git status");
    expect(d.deny).toContain("curl");
    // Builtins are visible, so the user knows what is unconditionally refused.
    expect(d.deny).toContain("rm -rf /");
  });
});

describe("request contents", () => {
  test("a bash request carries the full command and a suggestion", async () => {
    const { engine: e, recorded } = engine({ answer: { kind: "no" } });
    await runBash(e, "git status --short");

    const r = recorded.requests[0]!;
    expect(r.command).toBe("git status --short");
    expect(r.suggestion).toBe("git status");
    // Multi-line commands are shown in full, not summarized.
    expect(r.preview).toBe("git status --short");
  });

  test("a chained command asks when only part of it is allowed", async () => {
    // `cd` is not allowed, so the line asks even though `bun run` is.
    const { engine: e, recorded } = engine({ allow: ["bun run"], answer: { kind: "no" } });
    expect((await runBash(e, "cd /tmp/x && bun run verify.ts")).allow).toBe(false);
    expect(recorded.requests).toHaveLength(1);

    const withCd = engine({ allow: ["bun run", "cd"], answer: { kind: "no" } });
    expect((await runBash(withCd.engine, "cd /tmp/x && bun run verify.ts 2>&1")).allow).toBe(
      true,
    );
    expect(withCd.recorded.requests).toHaveLength(0);
  });

  test("an edit request carries a diff preview and no command", async () => {
    await Bun.write(`${dir}/a.ts`, "const x = 1;\n");
    const { engine: e, recorded } = engine({ answer: { kind: "no" } });
    await check(e, edit, { path: "a.ts", old_str: "const x = 1;", new_str: "const x = 2;" });

    const r = recorded.requests[0]!;
    expect(r.command).toBeUndefined();
    expect(r.preview).toContain("- const x = 1;");
    expect(r.preview).toContain("+ const x = 2;");
  });

  test("a preview that cannot be produced does not break the prompt", async () => {
    // The file does not exist, so edit_file's preview throws internally.
    const { engine: e, recorded } = engine({ answer: { kind: "no" } });
    await check(e, edit, { path: "missing.ts", old_str: "a", new_str: "b" });
    expect(recorded.requests[0]!.preview).toBeUndefined();
  });

  test("the preview is read-only — nothing is written before approval", async () => {
    await Bun.write(`${dir}/a.ts`, "const x = 1;\n");
    const { engine: e } = engine({ answer: { kind: "no" } });
    await check(e, edit, { path: "a.ts", old_str: "const x = 1;", new_str: "const x = 2;" });
    expect(readFileSync(`${dir}/a.ts`, "utf8")).toBe("const x = 1;\n");
  });
});
