/**
 * A multi-line text editor for the input prompt.
 *
 * Replaces readline with raw-mode input that supports:
 * - Multi-line editing (Shift+Enter / Ctrl+Enter for newline, Enter to submit)
 * - Syntax highlighting for slash commands, URLs, and quoted strings
 * - Auto-suggestions from history
 * - Tab completion for slash commands
 * - History navigation
 */
import { dim, cyan, yellow, stripAnsi } from "./ansi.ts";
import { SLASH_COMMANDS, completeSlash } from "./input.ts";

export type EditorResult = {
  text: string;
  submitted: boolean;
};

export type EditorOptions = {
  prompt?: string;
  history?: string[];
  prefill?: string;
  onResize?: () => void;
};

/**
 * Key codes from raw mode stdin.
 */
const KEY = {
  ENTER: 0x0a,
  CTRL_ENTER: 0x0a, // same byte; we distinguish by context
  CTRL_C: 0x03,
  CTRL_D: 0x04,
  CTRL_L: 0x0c,
  BACKSPACE: 0x7f,
  TAB: 0x09,
  ESC: 0x1b,
};

export class Editor {
  private buffer: string[] = [""]; // lines
  private cursorRow = 0; // row within buffer
  private cursorCol = 0; // col within current row
  private historyIndex = -1;
  private history: string[] = [];
  private prompt: string;
  private stdin: NodeJS.ReadStream;
  private stdout: NodeJS.WriteStream;
  private suggestion = "";

  constructor(opts: EditorOptions = {}) {
    this.prompt = opts.prompt ?? "› ";
    this.history = opts.history ?? [];
    this.stdin = process.stdin;
    this.stdout = process.stdout;
    if (opts.prefill) {
      this.buffer = opts.prefill.split("\n");
      this.cursorRow = this.buffer.length - 1;
      this.cursorCol = this.buffer[this.cursorRow]!.length;
    }
  }

  get text(): string {
    return this.buffer.join("\n");
  }

  /**
   * Show the editor and wait for the user to submit.
   * Returns the submitted text or undefined if cancelled.
   */
  async read(): Promise<EditorResult | undefined> {
    const wasRaw = this.stdin.isRaw;
    this.stdin.setRawMode(true);
    this.stdin.resume();

    this.render();

    try {
      for (;;) {
        const data = await new Promise<Buffer>((resolve) => {
          this.stdin.once("data", (chunk: Buffer) => resolve(chunk));
        });

        if (data.length === 0) continue;

        const key = data[0]!;

        // Ctrl-C
        if (key === KEY.CTRL_C) {
          this.clearLine();
          return undefined;
        }

        // Ctrl-D on empty line = exit
        if (key === KEY.CTRL_D && this.buffer.length === 1 && this.buffer[0] === "") {
          this.clearLine();
          return undefined;
        }

        // Enter
        if (key === KEY.ENTER) {
          // If shift is held (detected via escape sequence prefix), insert newline
          if (this.isShiftEnter(data)) {
            this.insertNewline();
            this.render();
            continue;
          }
          // Submit
          this.clearLine();
          return { text: this.text, submitted: true };
        }

        // Tab
        if (key === KEY.TAB) {
          if (this.suggestion) {
            // Accept suggestion
            const line = this.buffer[this.cursorRow]!;
            this.buffer[this.cursorRow] = line + this.suggestion;
            this.cursorCol = this.buffer[this.cursorRow]!.length;
            this.suggestion = "";
            this.render();
            continue;
          }
          // Tab complete slash commands
          const [hits] = completeSlash(this.buffer[this.cursorRow]!);
          if (hits.length === 1) {
            this.buffer[this.cursorRow] = hits[0]!;
            this.cursorCol = this.buffer[this.cursorRow]!.length;
            this.render();
          }
          continue;
        }

        // Escape sequences
        if (key === KEY.ESC && data.length > 1) {
          this.handleEscape(data);
          continue;
        }

        // Ctrl-L = clear screen (just redraw)
        if (key === KEY.CTRL_L) {
          this.stdout.write("\x1b[2J\x1b[H");
          this.render();
          continue;
        }

        // Backspace
        if (key === KEY.BACKSPACE) {
          this.backspace();
          this.render();
          continue;
        }

        // Printable characters
        if (key >= 0x20 && key <= 0x7e) {
          this.insertChar(String.fromCharCode(key));
          this.render();
          continue;
        }

        // Higher bytes = UTF-8 multi-byte sequence
        if (key >= 0xc0) {
          const seq = data.toString("utf8");
          this.insertChar(seq);
          this.render();
        }
      }
    } finally {
      this.stdin.setRawMode(wasRaw ?? false);
      this.stdin.pause();
    }
  }

  private isShiftEnter(data: Buffer): boolean {
    // Escape sequence: \x1b[13;2u  (kitty protocol)
    // or we can just use Ctrl+Enter instead
    return data.length >= 4 &&
      data[0] === 0x1b && data[1] === 0x5b &&
      data[2] === 0x31 && data[3] === 0x33;
  }

  private handleEscape(data: Buffer): void {
    if (data.length < 3) return;

    // Arrow keys: ESC [ A/B/C/D
    if (data[1] === 0x5b) {
      switch (data[2]) {
        case 0x41: // Up
          if (this.cursorRow > 0) {
            this.cursorRow--;
            this.cursorCol = Math.min(this.cursorCol, this.buffer[this.cursorRow]!.length);
          } else {
            // At first line: navigate history
            if (this.historyIndex < this.history.length - 1) {
              if (this.historyIndex === -1) {
                // Save current text for recall
                this.savedText = this.text;
              }
              this.historyIndex++;
              this.loadHistory(this.historyIndex);
            }
          }
          this.render();
          break;
        case 0x42: // Down
          if (this.cursorRow < this.buffer.length - 1) {
            this.cursorRow++;
            this.cursorCol = Math.min(this.cursorCol, this.buffer[this.cursorRow]!.length);
          } else if (this.historyIndex >= 0) {
            this.historyIndex--;
            if (this.historyIndex >= 0) {
              this.loadHistory(this.historyIndex);
            } else {
              // Restore saved text
              this.loadSaved();
            }
          }
          this.render();
          break;
        case 0x43: // Right
          if (this.cursorCol < this.buffer[this.cursorRow]!.length) {
            this.cursorCol++;
          } else if (this.cursorCol >= this.buffer[this.cursorRow]!.length &&
                     this.cursorRow < this.buffer.length - 1) {
            // Wrap to next line
            this.cursorRow++;
            this.cursorCol = 0;
          }
          this.render();
          break;
        case 0x44: // Left
          if (this.cursorCol > 0) {
            this.cursorCol--;
          } else if (this.cursorCol === 0 && this.cursorRow > 0) {
            // Wrap to previous line
            this.cursorRow--;
            this.cursorCol = this.buffer[this.cursorRow]!.length;
          }
          this.render();
          break;
        case 0x48: // Home
          this.cursorCol = 0;
          this.render();
          break;
        case 0x46: // End
          this.cursorCol = this.buffer[this.cursorRow]!.length;
          this.render();
          break;
      }
    }
  }

  private savedText = "";

  private loadHistory(index: number): void {
    const entry = this.history[index];
    if (entry) {
      this.buffer = entry.split("\n");
      this.cursorRow = this.buffer.length - 1;
      this.cursorCol = this.buffer[this.cursorRow]!.length;
    }
  }

  private loadSaved(): void {
    if (this.savedText) {
      this.buffer = this.savedText.split("\n");
      this.cursorRow = this.buffer.length - 1;
      this.cursorCol = this.buffer[this.cursorRow]!.length;
      this.savedText = "";
    }
  }

  private insertChar(ch: string): void {
    const line = this.buffer[this.cursorRow]!;
    this.buffer[this.cursorRow] = line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
    this.cursorCol += ch.length;
    this.updateSuggestion();
  }

  private insertNewline(): void {
    const line = this.buffer[this.cursorRow]!;
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);
    this.buffer[this.cursorRow] = before;
    this.buffer.splice(this.cursorRow + 1, 0, after);
    this.cursorRow++;
    this.cursorCol = 0;
    this.suggestion = "";
  }

  private backspace(): void {
    if (this.cursorCol > 0) {
      const line = this.buffer[this.cursorRow]!;
      this.buffer[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
      this.cursorCol--;
    } else if (this.cursorRow > 0) {
      // Merge with previous line
      const prevLine = this.buffer[this.cursorRow - 1]!;
      const curLine = this.buffer[this.cursorRow]!;
      this.cursorCol = prevLine.length;
      this.buffer[this.cursorRow - 1] = prevLine + curLine;
      this.buffer.splice(this.cursorRow, 1);
      this.cursorRow--;
    }
    this.updateSuggestion();
  }

  private updateSuggestion(): void {
    this.suggestion = "";
    const text = this.text;
    if (!text) return;

    // Find matching history entry
    for (const entry of this.history) {
      if (entry.startsWith(text) && entry !== text) {
        this.suggestion = entry.slice(text.length);
        // Only suggest first 40 chars
        if (this.suggestion.length > 40) {
          this.suggestion = this.suggestion.slice(0, 40) + "…";
        }
        break;
      }
    }
  }

  /**
   * Highlight syntax in the input text.
   * Highlights: slash commands (blue), quoted strings (green), URLs (cyan)
   */
  private highlightLine(line: string): string {
    // Highlight slash command at start
    if (line.startsWith("/")) {
      const spaceIdx = line.indexOf(" ");
      const cmd = spaceIdx > 0 ? line.slice(0, spaceIdx) : line;
      if (SLASH_COMMANDS.some((c) => c.name === cmd)) {
        const rest = spaceIdx > 0 ? line.slice(spaceIdx) : "";
        return cyan(cmd) + rest;
      }
    }

    // Highlight URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    line = line.replace(urlRegex, (url) => cyan(url));

    // Highlight quoted strings
    const strRegex = /(["'`])(?:(?!\1|\\).|\\.)*\1/g;
    line = line.replace(strRegex, (str) => yellow(str));

    return line;
  }

  private render(): void {
    // Save cursor position
    this.stdout.write("\x1b7");

    // Move to start of input area (below any existing content)
    this.stdout.write("\x1b[0G");

    // Clear from cursor to end of screen
    this.stdout.write("\x1b[J");

    // Render prompt
    this.stdout.write(this.prompt);

    // Render each line with syntax highlighting
    for (let i = 0; i < this.buffer.length; i++) {
      if (i > 0) {
        this.stdout.write("\n");
        // Indent continuation lines
        this.stdout.write(" ".repeat(stripAnsi(this.prompt).length));
      }
      const line = this.buffer[i]!;
      const highlighted = this.highlightLine(line);

      if (i === this.cursorRow) {
        this.stdout.write(highlighted);
        // Render suggestion
        if (this.suggestion) {
          this.stdout.write(dim(this.suggestion));
        }
      } else {
        this.stdout.write(highlighted);
      }
    }

    // Restore cursor
    this.stdout.write("\x1b8");

    // Move cursor to the right position
    const promptWidth = stripAnsi(this.prompt).length;
    const cursorScreenRow = this.cursorRow;
    const cursorScreenCol = promptWidth + this.cursorCol;

    this.stdout.write(`\x1b[${cursorScreenRow + 1}G`);
    if (cursorScreenCol > 0) {
      this.stdout.write(`\x1b[${cursorScreenCol}C`);
    }
  }

  private clearLine(): void {
    // Clear the input area
    this.stdout.write("\x1b7\x1b[0G\x1b[J\x1b8");
  }

  clear(): void {
    this.clearLine();
  }
}
