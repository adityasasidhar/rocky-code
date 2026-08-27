import { createHighlighter, type Highlighter, type TokenKind } from "./highlight.ts";
import {
  dim,
  NO_STYLE,
  style,
  type Style,
} from "./ansi.ts";
import { getCurrentTheme, themeColorToAnsi, themeColorReset } from "./theme.ts";

/**
 * A markdown renderer that paints text as it streams, one character at a time.
 *
 * The obvious implementation buffers each line and renders it on `\n`. That is
 * simple and wrong for this product: models emit prose as long lines, so the
 * user would watch a spinner and then get a paragraph in one jolt. Perceived
 * speed is the thing we are competing on.
 *
 * So this renderer buffers only as far as it must to decide what it is looking
 * at, and no further:
 *
 *   - At the start of a line it holds characters while the prefix is still a
 *     prefix of some block construct (`#`, `- `, `> `, ```` ``` ````, `1. `,
 *     `---`). The moment the prefix cannot be one, it replays what it held and
 *     streams the rest of the line character by character. That costs at most
 *     three characters of latency, and only on lines that look structural.
 *   - Inline, it opens the ANSI style when it sees `**` and closes it at the
 *     matching `**`, streaming the bolded text live rather than holding it.
 *     Lookahead is one character, to tell `**` from `*`.
 *
 * Code fences are the one place it does buffer a full line, because a syntax
 * highlighter cannot classify half a token. Code lines are short.
 *
 * Two deliberate omissions:
 *   - `_` never means emphasis. Models write `snake_case` far more often than
 *     they write `_emphasis_`, and corrupting an identifier is worse than
 *     under-styling a word.
 *   - Links render as their literal `[text](url)`, because a terminal cannot
 *     hide a URL the user may want to copy.
 *
 * An unclosed construct (`` ` ``, `**`) is closed at end of line rather than
 * leaking its colour into the rest of the transcript.
 */

export interface MarkdownTheme {
  heading(level: number): Style;
  bold: Style;
  italic: Style;
  code: Style;
  quote: Style;
  /** Already-styled bullet glyph, including any colour. */
  bullet: string;
  /** Rendered `---`. */
  rule(width: number): string;
  /** Paint one code token. */
  token(kind: TokenKind, text: string): string;
  /** Prefix for every line inside a fence. Two spaces keeps code copy-pastable. */
  codeIndent: string;
}

export const defaultTheme: MarkdownTheme = {
  heading: () => style("1;36", "0"),
  bold: style("1", "22"),
  italic: style("3", "23"),
  code: style("36", "39"),
  quote: style("90", "39"),
  bullet: "\x1b[36m•\x1b[39m",
  rule: (width) => dim("─".repeat(width)),
  token: (_kind: TokenKind, text: string) => text,
  codeIndent: "  ",
};

/** A theme that emits no escape codes. Used when output is not a terminal. */
export const plainTheme: MarkdownTheme = {
  heading: () => NO_STYLE,
  bold: NO_STYLE,
  italic: NO_STYLE,
  code: NO_STYLE,
  quote: NO_STYLE,
  bullet: "•",
  rule: (width) => "─".repeat(width),
  token: (_kind, text) => text,
  codeIndent: "  ",
};

/**
 * Create a MarkdownTheme that uses the current theme system colors.
 */
export function createThemeAwareMarkdownTheme(): MarkdownTheme {
  const theme = getCurrentTheme();

  const md = theme.markdown;
  const syn = theme.syntax;

  return {
    heading: (_level: number) => ({
      on: themeColorToAnsi(md.heading),
      off: themeColorReset(),
    }),
    bold: md.bold
      ? { on: themeColorToAnsi(md.bold), off: themeColorReset() }
      : style("1", "22"),
    italic: md.italic
      ? { on: themeColorToAnsi(md.italic), off: themeColorReset() }
      : style("3", "23"),
    code: {
      on: themeColorToAnsi(md.code),
      off: themeColorReset(),
    },
    quote: {
      on: themeColorToAnsi(md.blockquote),
      off: themeColorReset(),
    },
    bullet: themeColorToAnsi(md.listMarker) + "•" + themeColorReset(),
    rule: (width) => {
      const color = themeColorToAnsi(md.listMarker);
      return color + "─".repeat(width) + themeColorReset();
    },
    token: (kind: TokenKind, text: string) => {
      const colorMap: Record<TokenKind, string> = {
        keyword: syn.keyword,
        type: syn.type,
        literal: syn.constant,
        string: syn.string,
        number: syn.number,
        comment: syn.comment,
        func: syn.function,
        variable: syn.variable,
        punct: syn.punctuation,
        plain: "",
      };
      const color = colorMap[kind];
      if (!color) return text;
      return themeColorToAnsi(color) + text + themeColorReset();
    },
    codeIndent: "  ",
  };
}

type Block =
  | { kind: "fence" }
  | { kind: "heading"; level: number }
  | { kind: "bullet"; indent: number }
  | { kind: "ordered"; indent: number; label: string }
  | { kind: "quote" };

type Decision = "more" | "prose" | Block;

const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

const closesFence = (line: string): boolean => line.trimStart().startsWith("```");

export class MarkdownStream {
  /** `fence_info` is the remainder of the ``` line, i.e. the language. */
  private mode: "start" | "prose" | "fence" | "fence_info" | "table" = "start";
  /** Line-start lookahead, or the current code line inside a fence. */
  private pending = "";
  private highlighter: Highlighter | undefined;

  // Table state
  private tableHeaders: string[] = [];
  private tableAlign: ("left" | "center" | "right")[] = [];
  private tableRows: string[][] = [];
  private tableColWidths: number[] = [];

  // Inline state.
  private hold = "";
  private escaped = false;
  private code = false;
  private bold = false;
  private italic = false;
  /** Style opened for the whole line (heading, blockquote). */
  private lineOff = "";
  private skipSpace = false;

  constructor(
    private readonly sink: (s: string) => void,
    private readonly theme: MarkdownTheme = createThemeAwareMarkdownTheme(),
    private readonly width = 60,
  ) {}

  /** Feed streamed model text. Safe to call with any chunking, including one char. */
  push(text: string): void {
    for (const ch of text) this.char(ch);
  }

  /**
   * End the message: close any open style, commit any held text, and leave the
   * cursor at the start of a line. Idempotent.
   */
  flush(): void {
    switch (this.mode) {
      case "fence":
        // A message very often ends on its closing fence, with no trailing
        // newline. That is a fence close, not a line of code.
        if (this.pending && !closesFence(this.pending)) this.emitCodeLine(this.pending);
        this.pending = "";
        break;
      case "fence_info":
        this.pending = "";
        break;
      case "prose":
        this.endLine();
        break;
      case "start":
        if (this.pending) {
          const held = this.pending;
          this.pending = "";
          // Check if pending is a table row
          if (isTableRow(held)) {
            // Incomplete table, just emit as prose
            this.mode = "prose";
            for (const ch of held) this.inline(ch);
            this.endLine();
            break;
          }
          this.mode = "prose";
          for (const ch of held) this.inline(ch);
          this.endLine();
        }
        break;
      case "table":
        // Render the table if we have headers
        if (this.tableHeaders.length > 0) {
          this.renderTable();
        }
        break;
    }
    this.mode = "start";
    this.highlighter = undefined;
  }

  private char(c: string): void {
    switch (this.mode) {
      case "start":
        return this.atStart(c);
      case "prose":
        return this.inline(c);
      case "fence_info":
        return this.readFenceInfo(c);
      case "fence":
        return this.inFence(c);
      case "table":
        return this.inTable(c);
    }
  }

  // ---- line starts -------------------------------------------------------

  private atStart(c: string): void {
    if (c === "\n") {
      const held = this.pending;
      this.pending = "";

      // Check if this might be a table
      if (isTableRow(held)) {
        // Could be a table, wait for next line
        this.pending = held + "\n";
        return;
      }

      // If we were buffering a potential table header, emit it as prose
      if (this.pending.endsWith("\n")) {
        const lines = this.pending.split("\n");
        this.pending = "";
        for (const line of lines) {
          if (line) {
            this.mode = "prose";
            for (const ch of line) this.inline(ch);
            this.endLine();
          }
        }
        return;
      }

      const trimmed = held.trim();
      if (trimmed === "") {
        this.sink("\n");
        return;
      }
      if (RULE.test(trimmed)) {
        this.sink(`${this.theme.rule(this.width)}\n`);
        return;
      }
      // It looked structural, but the line ended: it was just text.
      this.mode = "prose";
      for (const ch of held) this.inline(ch);
      this.endLine();
      return;
    }

    // Check if we're buffering a potential table
    if (this.pending.includes("\n")) {
      const lines = this.pending.split("\n");
      const lastLine = lines[lines.length - 1]! + c;

      // If we have a header and this looks like a delimiter, start table
      if (lines.length === 2 && isTableDelimiter(lastLine)) {
        const headerLine = lines[0]!;
        this.tableHeaders = parseTableRow(headerLine);
        this.tableAlign = parseTableAlign(lastLine);
        this.tableRows = [];
        this.tableColWidths = this.tableHeaders.map((h) => h.length);
        this.pending = "";
        this.mode = "table";
        return;
      }

      // If we have a header and this isn't a delimiter, emit as prose
      if (lines.length === 2) {
        const allLines = lines.join("\n");
        this.pending = "";
        this.mode = "prose";
        for (const ch of allLines) this.inline(ch);
        this.endLine();
        return;
      }
    }

    this.pending += c;
    const decision = decide(this.pending);
    if (decision === "more") return;

    const held = this.pending;
    this.pending = "";

    if (decision === "prose") {
      this.mode = "prose";
      for (const ch of held) this.inline(ch);
      return;
    }
    this.openBlock(decision);
  }

  private openBlock(block: Block): void {
    switch (block.kind) {
      case "fence":
        this.mode = "fence_info";
        return;
      case "heading": {
        const s = this.theme.heading(block.level);
        this.sink(s.on);
        this.lineOff = s.off;
        this.mode = "prose";
        return;
      }
      case "bullet":
        this.sink(`${" ".repeat(block.indent)}${this.theme.bullet} `);
        this.mode = "prose";
        return;
      case "ordered":
        this.sink(`${" ".repeat(block.indent)}${dim(block.label)} `);
        this.mode = "prose";
        return;
      case "quote":
        this.sink(`${this.theme.quote.on}│ `);
        this.lineOff = this.theme.quote.off;
        this.mode = "prose";
        // `>` may or may not be followed by a space; swallow it if it is.
        this.skipSpace = true;
        return;
    }
  }

  // ---- fenced code -------------------------------------------------------

  private readFenceInfo(c: string): void {
    if (c !== "\n") {
      this.pending += c;
      return;
    }
    this.highlighter = createHighlighter(this.pending.trim());
    this.pending = "";
    this.mode = "fence";
  }

  private inFence(c: string): void {
    if (c !== "\n") {
      this.pending += c;
      return;
    }
    const line = this.pending;
    this.pending = "";
    if (closesFence(line)) {
      this.mode = "start";
      this.highlighter = undefined;
      return;
    }
    this.emitCodeLine(line);
  }

  private emitCodeLine(line: string): void {
    const painted = this.highlighter
      ? this.highlighter.line(line).map((t) => this.theme.token(t.kind, t.text)).join("")
      : line;
    this.sink(`${this.theme.codeIndent}${painted}\n`);
  }

  // ---- table -----------------------------------------------------------

  private inTable(c: string): void {
    if (c !== "\n") {
      this.pending += c;
      return;
    }

    const line = this.pending.trim();
    this.pending = "";

    // Empty line ends the table
    if (line === "") {
      this.renderTable();
      this.mode = "start";
      return;
    }

    // Non-table line ends the table
    if (!isTableRow(line)) {
      this.renderTable();
      this.mode = "start";
      this.pending = line + "\n";
      for (const ch of this.pending) this.char(ch);
      return;
    }

    // Add row to table
    const cells = parseTableRow(line);
    this.tableRows.push(cells);

    // Update column widths
    for (let i = 0; i < cells.length; i++) {
      if (i < this.tableColWidths.length) {
        this.tableColWidths[i] = Math.max(this.tableColWidths[i]!, cells[i]!.length);
      } else {
        this.tableColWidths.push(cells[i]!.length);
      }
    }
  }

  private renderTable(): void {
    if (this.tableHeaders.length === 0) return;

    const theme = getCurrentTheme();
    const borderColor = theme.markdown.tableBorder;
    const borderOn = themeColorToAnsi(borderColor);
    const borderOff = themeColorReset();

    // Render header
    const headerRow = this.tableHeaders.map((h, i) => h.padEnd(this.tableColWidths[i] || 0));
    this.sink(borderOn + "| " + borderOff);
    for (let i = 0; i < headerRow.length; i++) {
      this.sink(headerRow[i]!);
      if (i < headerRow.length - 1) {
        this.sink(borderOn + " | " + borderOff);
      }
    }
    this.sink(borderOn + " |" + borderOff + "\n");

    // Render delimiter
    this.sink(borderOn + "|" + borderOff);
    for (let i = 0; i < this.tableHeaders.length; i++) {
      const align = this.tableAlign[i] || "left";
      const width = this.tableColWidths[i] || 0;
      let delim = "";
      if (align === "left") delim = ":" + "-".repeat(Math.max(1, width - 1));
      else if (align === "right") delim = "-".repeat(Math.max(1, width - 1)) + ":";
      else delim = ":" + "-".repeat(Math.max(1, width - 2)) + ":";
      this.sink(borderOn + "-" + borderOff + delim.padEnd(width + 2, "-") + borderOn + "-" + borderOff);
      if (i < this.tableHeaders.length - 1) {
        this.sink(borderOn + "|" + borderOff);
      }
    }
    this.sink(borderOn + "|" + borderOff + "\n");

    // Render rows
    for (const row of this.tableRows) {
      const paddedRow = row.map((cell, i) => {
        const width = this.tableColWidths[i] || 0;
        const align = this.tableAlign[i] || "left";
        if (align === "right") return cell.padStart(width);
        if (align === "center") return cell.padStart(Math.floor((width + cell.length) / 2)).padEnd(width);
        return cell.padEnd(width);
      });
      this.sink(borderOn + "| " + borderOff);
      for (let i = 0; i < paddedRow.length; i++) {
        this.sink(paddedRow[i]!);
        if (i < paddedRow.length - 1) {
          this.sink(borderOn + " | " + borderOff);
        }
      }
      this.sink(borderOn + " |" + borderOff + "\n");
    }

    // Reset table state
    this.tableHeaders = [];
    this.tableAlign = [];
    this.tableRows = [];
    this.tableColWidths = [];
  }

  private inline(c: string): void {
    if (this.skipSpace) {
      this.skipSpace = false;
      if (c === " ") return;
    }

    if (c === "\n") return this.endLine();

    if (this.escaped) {
      this.escaped = false;
      this.sink(c);
      return;
    }

    // Inside a code span nothing else is markup.
    if (this.code) {
      if (c === "`") {
        this.sink(this.theme.code.off);
        this.code = false;
        return;
      }
      this.sink(c);
      return;
    }

    if (this.hold) {
      this.hold = "";
      if (c === "*") return this.toggle("bold");
      // `2 * 3`: an asterisk followed by a space is arithmetic, not emphasis.
      if (c === " ") {
        this.sink("* ");
        return;
      }
      this.toggle("italic");
      this.inline(c);
      return;
    }

    if (c === "\\") {
      this.escaped = true;
      return;
    }
    if (c === "`") {
      this.sink(this.theme.code.on);
      this.code = true;
      return;
    }
    if (c === "*") {
      // An open italic closes on the next `*`; otherwise wait one character to
      // see whether this is `*` or `**`.
      if (this.italic) return this.toggle("italic");
      this.hold = "*";
      return;
    }

    this.sink(c);
  }

  private toggle(which: "bold" | "italic"): void {
    const s = which === "bold" ? this.theme.bold : this.theme.italic;
    const open = which === "bold" ? this.bold : this.italic;
    this.sink(open ? s.off : s.on);
    if (which === "bold") this.bold = !open;
    else this.italic = !open;
  }

  private endLine(): void {
    if (this.hold) {
      this.sink(this.hold);
      this.hold = "";
    }
    if (this.escaped) {
      this.sink("\\");
      this.escaped = false;
    }
    if (this.code) {
      this.sink(this.theme.code.off);
      this.code = false;
    }
    if (this.italic) {
      this.sink(this.theme.italic.off);
      this.italic = false;
    }
    if (this.bold) {
      this.sink(this.theme.bold.off);
      this.bold = false;
    }
    if (this.lineOff) {
      this.sink(this.lineOff);
      this.lineOff = "";
    }
    this.sink("\n");
    this.mode = "start";
    this.pending = "";
    this.skipSpace = false;
  }
}

/**
 * Can this line prefix still become a block construct?
 *
 * Returns `more` only while genuinely ambiguous, so prose starts streaming
 * within a character or two of the line beginning.
 */
function decide(buf: string): Decision {
  const indent = buf.length - buf.trimStart().length;
  const t = buf.slice(indent);
  if (t === "") return "more";

  // ``` opens a fence; ` and `` are still ambiguous with an inline code span.
  if (t === "`" || t === "``") return "more";
  if (t.startsWith("```")) return { kind: "fence" };

  if (/^#{1,6}$/.test(t)) return "more";
  const heading = /^(#{1,6}) $/.exec(t);
  if (heading) return { kind: "heading", level: heading[1]!.length };

  if (t === ">") return { kind: "quote" };

  // A single `-`, `*`, `+` or `_` could open a bullet, a rule, or emphasis.
  if (t === "-" || t === "*" || t === "+" || t === "_") return "more";
  if (/^[-*+] $/.test(t)) return { kind: "bullet", indent };
  if (/^(-{2,}|\*{2,}|_{2,})$/.test(t)) return "more";

  if (/^\d+$/.test(t) || /^\d+\.$/.test(t)) return "more";
  const ordered = /^(\d+\.) $/.exec(t);
  if (ordered) return { kind: "ordered", indent, label: ordered[1]! };

  return "prose";
}

/**
 * Check if a line looks like a table row (contains pipe characters).
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

/**
 * Check if a line is a table delimiter row.
 */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;

  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * Parse table delimiter to determine column alignment.
 */
function parseTableAlign(delimiter: string): ("left" | "center" | "right")[] {
  const cells = delimiter
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  return cells.map((c) => {
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    return "left";
  });
}

/**
 * Parse a table row into cells.
 */
function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}
