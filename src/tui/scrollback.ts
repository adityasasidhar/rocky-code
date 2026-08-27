/**
 * Scrollback buffer — captures rendered output so the user can PageUp through it.
 *
 * Implementation approach: every line written to the terminal is captured in a
 * ring buffer. When the user presses PageUp, we switch to the alternate screen
 * buffer, render the buffered lines with a scrollable pager, and return to the
 * main view on Escape.
 */
import { dim, gray } from "./ansi.ts";

/** Maximum lines to keep in the buffer. */
const MAX_LINES = 10_000;

/**
 * Captures output lines and provides a scrollable pager view.
 */
export class Scrollback {
  private readonly buffer: string[] = [];
  private cursor = 0;

  /** How many physical lines the terminal uses for its status bar / chrome. */
  private readonly reserveLines = 2;

  /** Record a line of output. Call once per line written to the terminal. */
  append(line: string): void {
    // Split on newlines, but keep ANSI codes intact.
    for (const part of line.split("\n")) {
      if (this.buffer.length >= MAX_LINES) {
        this.buffer.shift();
      }
      this.buffer.push(part);
    }
  }

  /** Total buffered lines. */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Enter scrollback mode: switch to the alternate screen and show the pager.
   * Returns when the user presses Escape.
   *
   * @param out - The output stream (usually process.stdout).
   * @param stdin - The input stream for reading keys (usually process.stdin).
   */
  async view(out: NodeJS.WriteStream, stdin: NodeJS.ReadStream): Promise<void> {
    if (this.buffer.length === 0) return;

    const rows = (out.rows || 24) - this.reserveLines;
    this.cursor = Math.max(0, this.buffer.length - rows);

    // Switch to alternate screen buffer
    out.write("\x1b[?1049h\x1b[2J\x1b[H");

    // Save/restore terminal modes
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const render = () => {
      const end = Math.min(this.cursor + rows, this.buffer.length);
      const start = Math.max(0, end - rows);
      const slice = this.buffer.slice(start, end);

      const lines = slice.map((l, i) => {
        const lineNum = dim(String(start + i + 1).padStart(6)) + " ";
        return lineNum + l;
      });

      // Fill remaining rows if short
      while (lines.length < rows) {
        lines.push("");
      }

      out.write("\x1b[H"); // move to home
      out.write(lines.join("\n"));

      // Status line
      const pct = this.buffer.length > 0
        ? Math.round((start / this.buffer.length) * 100)
        : 0;
      out.write(
        `\n${gray(`lines ${start + 1}–${end} of ${this.buffer.length} (${pct}%) · ↑↓/PgUp/PgDn scroll · Esc exit`)}`,
      );
    };

    render();

    try {
      for (;;) {
        const data = await new Promise<Buffer>((resolve) => {
          stdin.once("data", (chunk: Buffer) => resolve(chunk));
        });

        const len = data.length;
        if (len === 0) continue;

        // Escape sequence
        if (data[0] === 0x1b) {
          if (len === 1) {
            // Plain Escape — exit
            break;
          }
          // Escape sequence: [, O, etc.
          if (len > 2 && (data[1] === 0x5b || data[1] === 0x4f)) {
            const cmd = data[2];
            if (cmd === 0x41) {
              // Up arrow
              if (this.cursor > 0) this.cursor--;
              render();
            } else if (cmd === 0x42) {
              // Down arrow
              if (this.cursor < this.buffer.length - rows) this.cursor++;
              render();
            } else if (cmd === 0x35) {
              // PageUp (ESC [ 5 ~)
              this.cursor = Math.max(0, this.cursor - rows);
              render();
            } else if (cmd === 0x36) {
              // PageDown (ESC [ 6 ~)
              this.cursor = Math.min(this.buffer.length - rows, this.cursor + rows);
              render();
            } else if (cmd === 0x48) {
              // Home
              this.cursor = 0;
              render();
            } else if (cmd === 0x46) {
              // End
              this.cursor = Math.max(0, this.buffer.length - rows);
              render();
            }
          }
        } else if (data[0] === 0x03) {
          // Ctrl-C
          break;
        }
      }
    } finally {
      // Restore terminal
      out.write("\x1b[?1049l"); // switch back to main screen buffer
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    }
  }
}
