import type { LoopEvent } from "../core/loop.ts";
import type { ToolResult } from "../tools/types.ts";
import {
  bold,
  colorDiff,
  cyan,
  dim,
  gray,
  green,
  red,
  Spinner,
  stripAnsi,
  yellow,
} from "./ansi.ts";
import { defaultTheme, MarkdownStream } from "./markdown.ts";
import type { StatusBar } from "./status.ts";
import type { Scrollback } from "./scrollback.ts";

const indent = (s: string, pad = "    ") =>
  s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");

/**
 * Wraps streamed text to terminal width, indenting continuation lines.
 *
 * Holding back text breaks perceived speed. Instead we hold at most one word
 * and emit as soon as we know it fits; only when a word would overflow do we
 * insert a newline + indent first. Stream-friendly: chunks can split words,
 * the next chunk resumes without re-counting.
 */
class LineWrapper {
  private word = "";
  private col: number;
  private startOfLine: boolean;

  constructor(
    private readonly sink: (s: string) => void,
    private readonly width: () => number,
    private readonly indent: string,
    startCol = 0,
  ) {
    this.col = startCol;
    this.startOfLine = startCol === 0;
  }

  push(text: string): void {
    for (const ch of text) {
      if (ch === "\n") {
        this.flushWord();
        this.sink("\n");
        this.col = 0;
        this.startOfLine = true;
      } else if (ch === " " || ch === "\t") {
        this.flushWord();
      } else {
        this.word += ch;
      }
    }
  }

  /** Release the held word, if any. Safe to call at end of stream. */
  flush(): void {
    this.flushWord();
  }

  private flushWord(): void {
    if (!this.word) return;
    const w = this.word;
    this.word = "";

    const limit = Math.max(this.indent.length + 2, this.width());

    if (!this.startOfLine && this.col + 1 + w.length > limit) {
      this.sink("\n");
      this.sink(this.indent);
      this.col = this.indent.length;
      this.startOfLine = true;
    }

    if (!this.startOfLine) {
      this.sink(" ");
      this.col += 1;
    }

    this.sink(w);
    this.col += w.length;
    this.startOfLine = false;
  }
}

/**
 * A tool result hangs off its call the way Claude Code draws it:
 *
 *   ⏺ bash(bun test)
 *     ⎿ 589 pass
 *       0 fail
 *
 * The elbow marks where output starts; continuation lines align under it.
 */
const elbow = (s: string, mark = "") => {
  const [first = "", ...rest] = s.split("\n");
  const head = `  ${dim("⎿")} ${mark}${first}`;
  return rest.length === 0 ? head : `${head}\n${indent(rest.join("\n"))}`;
};

/** Output longer than this is collapsed; the user can ask for the rest. */
const COLLAPSE_AFTER_LINES = 10;
const HEAD_LINES = 6;

/**
 * What Rocky is doing while nothing streams. Eridians perceive by sound, so
 * the idle verbs are his: heard on the status line, one per wait.
 */
export const WAIT_VERBS = [
  "Observing",
  "Resonating",
  "Harmonizing",
  "Calculating",
  "Triangulating",
  "Composing",
  "Listening",
  "Sampling",
  "Questioning",
  "Pondering",
] as const;

/**
 * Every tool result of the session, so a collapsed block can be reopened.
 *
 * A terminal cannot un-print a line, so "collapsible" here does not mean a
 * widget that folds. It means: print a summary, keep the whole thing, and let
 * `/expand <n>` reprint it. Nothing the agent did is ever unrecoverable from
 * the transcript, which is the property that actually matters.
 */
export class ToolLog {
  private readonly entries: { name: string; output: string }[] = [];

  /** Returns the 1-based id the user types after `/expand`. */
  add(name: string, output: string): number {
    this.entries.push({ name, output });
    return this.entries.length;
  }

  get(id: number): { name: string; output: string } | undefined {
    return this.entries[id - 1];
  }

  get size(): number {
    return this.entries.length;
  }
}

export type RendererOptions = {
  /** Print thinking as it streams. */
  showThinking?: boolean;
  /** Print full tool output rather than a collapsed summary. */
  verbose?: boolean;
  /** Render markdown and colour. Defaults to "the stream is a terminal". */
  markdown?: boolean;
  /** Shared across turns so `/expand` can reach earlier tool calls. */
  log?: ToolLog;
  /** Fixed status bar at the bottom of the terminal. */
  statusBar?: StatusBar;
  /** Capture output for scrollback viewing. */
  scrollback?: Scrollback;
  /** Provider name for the status bar. */
  providerName?: string;
  /** Model name for the status bar. */
  modelName?: string;
  /** Permission mode for the status bar. */
  permissionMode?: string;
  /**
   * Route activity ("Observing…", "running bash…") to an external indicator
   * instead of the inline spinner. The footer UI owns the status line, and
   * two things repainting one terminal cannot both win.
   */
  onActivity?: (label: string | null) => void;
};

/**
 * Streams loop events to a terminal. The invariant: the user always knows what
 * the agent is doing right now, and nothing is printed that they cannot trace
 * back to a tool call.
 */
export class Renderer {
  private readonly spinner: Spinner;
  private atLineStart = true;
  private inThinking = false;
  private thinkingWrap: LineWrapper | undefined;
  private readonly running = new Map<string, string>();
  /** Collected assistant prose, so -p mode can print just the answer. */
  private readonly answer: string[] = [];
  private readonly markdown: MarkdownStream | undefined;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly opts: RendererOptions = {},
  ) {
    this.spinner = new Spinner(out);
    const useMarkdown = opts.markdown ?? out.isTTY === true;
    this.markdown = useMarkdown
      ? new MarkdownStream(
          (s) => this.write(s),
          defaultTheme,
          Math.min(out.columns ?? 80, 80),
        )
      : undefined;
  }

  /** The model's prose, exactly as it was streamed. Never markdown-rendered. */
  get finalText(): string {
    return this.answer.join("").trim();
  }

  private write(s: string): void {
    if (!s) return;
    // Reserve room for the status bar at the bottom of the terminal.
    this.opts.statusBar?.protect();
    // Capture output for scrollback.
    this.opts.scrollback?.append(s);
    this.out.write(s);
    // Styling carries no position, so it must not decide whether we are at the
    // start of a line.
    const visible = stripAnsi(s);
    if (visible) this.atLineStart = visible.endsWith("\n");
  }

  private newline(): void {
    if (!this.atLineStart) this.write("\n");
  }

  /** Commit any partially rendered markdown before printing something else. */
  private flushMarkdown(): void {
    this.markdown?.flush();
  }

  /**
   * Show that we are waiting on the model. Called at turn start and after each
   * tool result — the stretches where nothing streams and a silent terminal
   * reads as a hang. The verb is one of Rocky's; the clock counts this wait,
   * not the turn, because "how long has nothing happened" is the question the
   * user is actually asking.
   */
  wait(): void {
    const verb = WAIT_VERBS[Math.floor(Math.random() * WAIT_VERBS.length)]!;
    if (this.opts.onActivity) {
      this.opts.onActivity(verb);
      return;
    }
    const since = Date.now();
    this.spinner.start(() => {
      const s = Math.floor((Date.now() - since) / 1000);
      return `${verb}… ${dim(`${s}s · esc to interrupt`)}`;
    });
  }

  handle(event: LoopEvent): void {
    switch (event.type) {
      case "compacted":
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(
          `${cyan("⧉")} ${bold("compacted")} ${dim(
            `${event.before} → ${event.after} messages ` +
              `(${event.droppedMessages} summarized)`,
          )}\n`,
        );
        if (this.opts.verbose) this.write(`${indent(gray(event.recap))}\n`);
        return;

      case "thinking_delta":
        if (!this.opts.showThinking) return;
        this.spinner.stop();
        this.opts.onActivity?.(null);
        if (!this.inThinking) {
          this.newline();
          this.write(`${dim("▸")} ${dim("thinking")}\n`);
          this.thinkingWrap = new LineWrapper(
            (s) => this.write(gray(s)),
            () => Math.max(40, (this.out.columns ?? 80) - 4),
            "  ",
            0,
          );
          this.inThinking = true;
        }
        this.thinkingWrap!.push(event.text);
        return;

      case "text_delta":
        this.spinner.stop();
        this.opts.onActivity?.(null);
        if (this.inThinking) {
          this.thinkingWrap?.flush();
          this.thinkingWrap = undefined;
          this.newline();
          this.inThinking = false;
        }
        // Dynamic TrueForge subagent prose is visible activity, not the root
        // answer returned by `rocky -p`.
        if (!event.depth) this.answer.push(event.text);
        if (this.markdown) this.markdown.push(event.text);
        else this.write(event.text);
        return;

      case "phase":
        this.opts.onActivity?.(event.phase === "idle" ? null : event.detail ?? event.phase);
        return;

      case "infrastructure": {
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        const mark = event.status === "error" ? red("◆") : cyan("◆");
        this.write(`${mark} ${bold(event.component)} ${dim(`${event.status} · ${event.detail}`)}\n`);
        return;
      }

      case "thread_start":
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(`${cyan("↳")} ${bold(event.agent)} ${dim(`${event.title} · ${event.id.slice(0, 8)}`)}\n`);
        return;

      case "thread_end":
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(
          `${event.ok ? green("↳") : red("↳")} ${bold("subagent")} ${dim(
            `${event.ok ? "done" : "failed"}${event.detail ? ` · ${event.detail}` : ""}`,
          )}\n`,
        );
        return;

      case "tool_start": {
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(
          `${cyan("⏺")} ${bold(event.name)}${dim(`(${this.oneLine(event.summary)})`)}\n`,
        );
        this.running.set(event.id, event.name);
        if (this.opts.onActivity) {
          this.opts.onActivity(`running ${event.name}`);
          return;
        }
        const since = Date.now();
        this.spinner.start(() => {
          const s = Math.floor((Date.now() - since) / 1000);
          return dim(`running ${event.name}… ${s}s · esc to interrupt`);
        });
        return;
      }

      case "tool_denied":
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(
          `${red("⏺")} ${bold(event.name)}${dim(`(${this.oneLine(event.summary)})`)}\n` +
            `${elbow(red(`denied: ${event.reason}`))}\n`,
        );
        // The denial is itself a tool result; the model reacts to it next.
        this.wait();
        return;

      case "tool_end": {
        this.spinner.stop();
        this.running.delete(event.id);
        this.write(this.renderResult(event.name, event.result));
        // The results go back to the model now; show that we are on it.
        this.wait();
        return;
      }

      case "check": {
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        const head = `${event.ok ? cyan("⏺") : red("⏺")} ${bold("check")}${dim(`(${this.oneLine(event.command)})`)}\n`;
        this.write(
          head + `${elbow(event.ok ? dim("passed") : red(event.summary || "failed"))}\n`,
        );
        // Like a tool result, the check's outcome goes back to the model next.
        this.wait();
        return;
      }

      case "notice":
        this.spinner.stop();
        this.flushMarkdown();
        this.newline();
        this.write(`${yellow("!")} ${event.text}\n`);
        return;

      case "turn_end":
        this.spinner.stop();
        this.thinkingWrap?.flush();
        this.thinkingWrap = undefined;
        this.inThinking = false;
        this.flushMarkdown();
        this.newline();
        if (event.stopReason === "aborted") {
          this.write(`${yellow("⎋")} ${dim("interrupted")}\n`);
        }
        return;
    }
  }

  /** Tool summaries can be long or multi-line; the header gets one line. */
  private oneLine(s: string): string {
    const flat = s.replace(/\s*\n\s*/g, " ");
    const max = Math.max(20, (this.out.columns ?? 80) - 8);
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  }

  private renderResult(name: string, result: ToolResult): string {
    const diff = result.meta?.["diff"];
    if (typeof diff === "string" && diff) {
      return `${elbow(colorDiff(diff))}\n`;
    }

    // The todo list draws as the checklist it is, not as the tool's one-line
    // confirmation. meta is TUI-only, so the shape check is a courtesy.
    const todos = result.meta?.["todos"];
    if (Array.isArray(todos) && todos.length > 0) {
      const rows = todos.map((t: { content: string; status: string }) =>
        t.status === "completed"
          ? `${green("✓")} ${dim(t.content)}`
          : t.status === "in_progress"
            ? `${cyan("→")} ${bold(t.content)}`
            : `${dim("☐")} ${t.content}`,
      );
      return `${elbow(rows.join("\n"))}\n`;
    }

    const mark = result.isError ? `${red("✗")} ` : "";

    if (this.opts.verbose) {
      return `${elbow(result.output, mark)}\n`;
    }

    const lines = result.output.replace(/\n+$/, "").split("\n");
    if (lines.length === 1 && !lines[0]?.trim()) {
      return `${elbow(dim("(no output)"), mark)}\n`;
    }

    if (lines.length <= COLLAPSE_AFTER_LINES) {
      return `${elbow(lines.join("\n"), mark)}\n`;
    }

    // Too long to print. Keep it, summarize it, and say how to get it back.
    const id = this.opts.log?.add(name, result.output);
    const hidden = lines.length - HEAD_LINES;
    const how = id === undefined ? "-v to see all" : `/expand ${id}`;
    return (
      `${elbow(lines.slice(0, HEAD_LINES).join("\n"), mark)}\n` +
      `${indent(dim(`… ${hidden} more lines · ${how}`))}\n`
    );
  }

  /**
   * Stop the status spinner so something else can own the line — a permission
   * prompt reads a keypress on the same terminal, and a spinner repainting
   * every 80ms would erase the question as fast as it is asked.
   */
  quiet(): void {
    this.spinner.stop();
  }

  /** Call before exiting so the cursor is restored even on Ctrl-C. */
  close(): void {
    this.spinner.stop();
    this.thinkingWrap?.flush();
    this.thinkingWrap = undefined;
    this.flushMarkdown();
    this.newline();
  }
}
