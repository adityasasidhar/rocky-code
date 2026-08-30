import { describe, expect, test } from "bun:test";
import type { LoopEvent } from "../../src/core/loop.ts";
import { emptyUsage } from "../../src/core/types.ts";
import { Renderer, ToolLog, type RendererOptions } from "../../src/tui/render.ts";
import type { ToolResult } from "../../src/tools/types.ts";

type Harness = { r: Renderer; out: () => string };

/** A Renderer writing into a string. Not a TTY, so no colour and no markdown. */
const harness = (opts: RendererOptions = {}): Harness => {
  let buf = "";
  const stream = {
    write: (s: string) => {
      buf += s;
      return true;
    },
    isTTY: false,
    columns: 80,
  } as unknown as NodeJS.WriteStream;
  return { r: new Renderer(stream, opts), out: () => buf };
};

const result = (output: string, isError = false): ToolResult => ({ output, isError });

const toolEnd = (name: string, res: ToolResult): LoopEvent => ({
  type: "tool_end",
  id: "t1",
  name,
  result: res,
});

const lines = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("tool result rendering", () => {
  test("short output is printed in full", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result("a\nb\nc")));
    expect(out()).toContain("a\n");
    expect(out()).toContain("c\n");
    expect(out()).not.toContain("more lines");
  });

  test("empty output says so rather than printing nothing", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result("")));
    expect(out()).toContain("(no output)");
  });

  test("output at the collapse threshold is still printed whole", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result(lines(10))));
    expect(out()).toContain("line 10");
    expect(out()).not.toContain("more lines");
  });

  test("long output collapses to a head plus a count", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result(lines(20))));
    expect(out()).toContain("line 6");
    expect(out()).not.toContain("line 7");
    expect(out()).toContain("… 14 more lines");
  });

  test("trailing blank lines do not inflate the hidden count", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result(`${lines(20)}\n\n\n`)));
    expect(out()).toContain("… 14 more lines");
  });

  test("verbose prints everything and collapses nothing", () => {
    const { r, out } = harness({ verbose: true });
    r.handle(toolEnd("bash", result(lines(50))));
    expect(out()).toContain("line 50");
    expect(out()).not.toContain("more lines");
  });

  test("a diff is rendered instead of the raw output", () => {
    const { r, out } = harness();
    r.handle(
      toolEnd("edit_file", {
        output: "ok",
        isError: false,
        meta: { diff: "-old\n+new" },
      }),
    );
    expect(out()).toContain("-old");
    expect(out()).toContain("+new");
    expect(out()).not.toContain("ok");
  });

  test("errors are marked, and still collapse", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result(lines(20), true)));
    expect(out()).toContain("✗");
    expect(out()).toContain("more lines");
  });
});

describe("collapsed output stays recoverable", () => {
  test("a collapsed result is stored and points at /expand", () => {
    const log = new ToolLog();
    const { r, out } = harness({ log });
    r.handle(toolEnd("bash", result(lines(20))));

    expect(out()).toContain("/expand 1");
    expect(log.size).toBe(1);
    // The whole output is kept, not the truncated head.
    expect(log.get(1)?.output).toBe(lines(20));
    expect(log.get(1)?.name).toBe("bash");
  });

  test("ids increase, and only collapsed results take one", () => {
    const log = new ToolLog();
    const { r } = harness({ log });
    r.handle(toolEnd("bash", result(lines(20))));
    r.handle(toolEnd("read_file", result("short")));
    r.handle(toolEnd("grep", result(lines(30))));

    expect(log.size).toBe(2);
    expect(log.get(1)?.name).toBe("bash");
    expect(log.get(2)?.name).toBe("grep");
  });

  test("out-of-range ids return undefined rather than throwing", () => {
    const log = new ToolLog();
    expect(log.get(1)).toBeUndefined();
    expect(log.get(0)).toBeUndefined();
    expect(log.get(-1)).toBeUndefined();
  });

  test("without a log, the hint offers -v instead of a dangling id", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result(lines(20))));
    expect(out()).toContain("-v to see all");
    expect(out()).not.toContain("/expand");
  });
});

describe("todo checklist", () => {
  test("meta.todos draws as a checklist, not the confirmation line", () => {
    const { r, out } = harness();
    r.handle(
      toolEnd("todo_write", {
        output: "Todo list updated: 1/3 done; in progress: fix the bug",
        isError: false,
        meta: {
          todos: [
            { content: "read the code", status: "completed" },
            { content: "fix the bug", status: "in_progress" },
            { content: "run tests", status: "pending" },
          ],
        },
      }),
    );
    const text = out();
    expect(text).toContain("✓ read the code");
    expect(text).toContain("→ fix the bug");
    expect(text).toContain("☐ run tests");
    // The one-line confirmation is for the model; the user gets the list.
    expect(text).not.toContain("Todo list updated");
  });
});

describe("tool call blocks", () => {
  test("the header is name(args), Claude Code style", () => {
    const { r, out } = harness();
    r.handle({ type: "tool_start", id: "t1", name: "bash", summary: "bun test" });
    expect(out()).toContain("⏺ bash(bun test)\n");
  });

  test("a multi-line summary is flattened to one header line", () => {
    const { r, out } = harness();
    r.handle({
      type: "tool_start",
      id: "t1",
      name: "bash",
      summary: "line one\n  line two",
    });
    expect(out()).toContain("bash(line one line two)");
  });

  test("an overlong summary is truncated to the terminal, not wrapped", () => {
    const { r, out } = harness();
    r.handle({ type: "tool_start", id: "t1", name: "bash", summary: "x".repeat(300) });
    const header = out().split("\n").find((l) => l.includes("bash("))!;
    expect(header.length).toBeLessThanOrEqual(90);
    expect(header).toContain("…");
  });

  test("results hang off an elbow under the call", () => {
    const { r, out } = harness();
    r.handle(toolEnd("bash", result("first\nsecond")));
    expect(out()).toContain("⎿ first\n");
    expect(out()).toContain("    second");
  });
});

describe("streams", () => {
  test("non-TTY output is the model's text verbatim, not markdown-rendered", () => {
    const { r, out } = harness();
    r.handle({ type: "text_delta", text: "# Title\n**bold**\n" });
    r.close();
    // Piping must preserve exactly what the model said.
    expect(out()).toBe("# Title\n**bold**\n");
    expect(r.finalText).toBe("# Title\n**bold**");
  });

  test("non-TTY output preserves repeated whitespace across stream chunks", () => {
    const { r, out } = harness();
    r.handle({ type: "text_delta", text: "aligned:  " });
    r.handle({ type: "text_delta", text: "left\t\tright\n" });
    r.close();
    expect(out()).toBe("aligned:  left\t\tright\n");
  });

  test("markdown can be forced on, and finalText stays raw", () => {
    const { r, out } = harness({ markdown: true });
    r.handle({ type: "text_delta", text: "# Title\n" });
    r.close();
    expect(out()).toBe("Title\n");
    // stdout in -p mode prints finalText, which must remain the raw markdown.
    expect(r.finalText).toBe("# Title");
  });

  test("a partial markdown line is committed before a tool block prints", () => {
    const { r, out } = harness({ markdown: true });
    r.handle({ type: "text_delta", text: "Let me check" });
    r.handle({ type: "tool_start", id: "t1", name: "bash", summary: "ls" });
    expect(out()).toContain("Let me check\n");
    expect(out()).toContain("bash");
  });

  test("interruption is reported", () => {
    const { r, out } = harness();
    r.handle({ type: "turn_end", stopReason: "aborted", usage: emptyUsage() });
    expect(out()).toContain("interrupted");
  });

  test("a denial names the tool and the reason", () => {
    const { r, out } = harness();
    r.handle({
      type: "tool_denied",
      id: "t1",
      name: "bash",
      summary: "rm -rf /tmp/x",
      reason: "denied by rule",
    });
    expect(out()).toContain("bash");
    expect(out()).toContain("rm -rf /tmp/x");
    expect(out()).toContain("denied by rule");
  });
});

describe("thinking rendering", () => {
  test("hidden by default — showThinking is opt-in", () => {
    const { r, out } = harness();
    r.handle({ type: "thinking_delta", text: "hidden reasoning" });
    r.close();
    expect(out()).toBe("");
  });

  test("shown when showThinking is true, with a labelled header", () => {
    const { r, out } = harness({ showThinking: true });
    r.handle({ type: "thinking_delta", text: "weighing it" });
    r.close();
    expect(out()).toContain("thinking");
    expect(out()).toContain("weighing it");
  });

  test("a long thinking stream wraps with indented continuation lines", () => {
    // Width is 80 (harness default). Indent is "  ".
    // Two passes force a wrap somewhere in the second copy.
    const { r, out } = harness({ showThinking: true });
    const phrase = "alpha beta gamma delta epsilon zeta eta theta";
    r.handle({ type: "thinking_delta", text: phrase });
    r.handle({ type: "thinking_delta", text: " " + phrase });
    r.close();
    const text = stripAnsi(out());
    expect(text).toContain("thinking\n");
    // A wrap happened, and the wrapped line carries the indent prefix.
    expect(text).toMatch(/\n {2}\w/);
    // The first content line under the header is *not* indented — only
    // continuation lines are.
    const afterHeader = text.slice(text.indexOf("thinking\n") + "thinking\n".length);
    const lines = afterHeader.split("\n");
    expect(lines[0]?.startsWith("  ")).toBe(false);
  });

  test("a hard newline in the stream resets wrap state cleanly", () => {
    const { r, out } = harness({ showThinking: true });
    r.handle({ type: "thinking_delta", text: "first paragraph\nsecond paragraph" });
    r.close();
    const text = stripAnsi(out());
    expect(text).toContain("first paragraph");
    expect(text).toContain("second paragraph");
  });

  test("a turn_end flushes any held wrap state", () => {
    const { r, out } = harness({ showThinking: true });
    r.handle({ type: "thinking_delta", text: "tail" });
    r.handle({ type: "turn_end", stopReason: "end_turn", usage: emptyUsage() });
    expect(stripAnsi(out())).toContain("tail");
  });
});

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
