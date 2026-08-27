import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../../src/permissions/engine.ts";
import {
  interpret,
  nonInteractiveAsk,
  renderRequest,
} from "../../src/permissions/prompt.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { editFileTool } from "../../src/tools/edit_file.ts";
import { erase } from "../../src/tools/types.ts";

const bash = erase(bashTool);
const edit = erase(editFileTool);

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  tool: bash,
  title: "run tests",
  command: "bun test",
  ...over,
});

describe("interpret", () => {
  test.each([
    ["y", "once"],
    ["n", "no"],
    ["q", "no"],
    ["a", "session"],
    ["p", "persist"],
  ] as const)("%s -> %s", (key, kind) => {
    expect(interpret(key)?.kind).toBe(kind);
  });

  test("an unrecognized key is not an answer, so the prompt repeats", () => {
    expect(interpret("z")).toBeUndefined();
    expect(interpret("")).toBeUndefined();
  });
});

describe("renderRequest", () => {
  test("shows the full command verbatim", () => {
    const out = renderRequest(request({ command: "rm -rf node_modules && bun install" }));
    expect(out).toContain("rm -rf node_modules && bun install");
  });

  test("offers the suggested rule by name", () => {
    const out = renderRequest(request({ suggestion: "bun test" }));
    expect(out).toContain("always allow");
    expect(out).toContain("bun test");
  });

  test("names the tool when there is no narrow suggestion", () => {
    const out = renderRequest(request({ suggestion: undefined }));
    expect(out).toContain("always allow this tool");
  });

  test("shows a diff preview for an edit", () => {
    const out = renderRequest(
      request({
        tool: edit,
        command: undefined,
        title: "src/a.ts",
        preview: "- const x = 1;\n+ const x = 2;",
      }),
    );
    expect(out).toContain("const x = 1;");
    expect(out).toContain("const x = 2;");
    expect(out).toContain("src/a.ts");
  });

  test("a preview that repeats the command is not printed twice", () => {
    // bash's preview *is* the command; the prompt showed it once as the
    // headline and again as the preview until a live run caught it.
    const out = renderRequest(request({ command: "ls *.txt", preview: "ls *.txt" }));
    expect(out.split("ls *.txt")).toHaveLength(2); // exactly one occurrence
  });

  test("a very long preview is truncated with a count", () => {
    const preview = Array.from({ length: 100 }, (_, i) => `+ line ${i}`).join("\n");
    const out = renderRequest(request({ tool: edit, command: undefined, preview }));
    expect(out).toContain("60 more lines");
    expect(out).not.toContain("line 99");
  });

  test("always lists all four choices", () => {
    const out = renderRequest(request());
    for (const key of ["y", "n", "a", "p"]) expect(out).toContain(key);
    expect(out).toContain(".rocky/settings.json");
  });

  test("one-shot approvals only offer yes or no", () => {
    const output = renderRequest({
      tool: { name: "workspace_apply_patch" },
      title: "apply candidate",
      onceOnly: true,
    });
    expect(output).toContain("yes, once");
    expect(output).toContain("no");
    expect(output).not.toContain("always allow");
    expect(output).not.toContain("always, and save");
  });
});

describe("nonInteractiveAsk", () => {
  test("refuses, because there is nobody to ask", async () => {
    const answer = await nonInteractiveAsk()(request());
    expect(answer.kind).toBe("no");
  });

  test("tells the operator exactly how to unblock a bash call", async () => {
    const answer = await nonInteractiveAsk()(request({ suggestion: "bun test" }));
    if (answer.kind !== "no") throw new Error("expected refusal");

    expect(answer.reason).toContain("--yolo");
    expect(answer.reason).toContain('add "bun test" to `allow`');
  });

  test("points at allowTools for a non-bash tool", async () => {
    const answer = await nonInteractiveAsk()(
      request({ tool: edit, command: undefined, suggestion: undefined }),
    );
    if (answer.kind !== "no") throw new Error("expected refusal");
    expect(answer.reason).toContain('add "edit_file" to `allowTools`');
  });

  test("falls back to a generic hint for an unsummarizable command", async () => {
    const answer = await nonInteractiveAsk()(
      request({ command: "a && b", suggestion: undefined }),
    );
    if (answer.kind !== "no") throw new Error("expected refusal");
    expect(answer.reason).toContain("add an `allow` rule");
  });
});
