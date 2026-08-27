/**
 * A fixed status bar at the bottom of the terminal.
 *
 * Uses ANSI positioning to keep the last line reserved for session status:
 * provider · model · context meter · mode.
 *
 * The approach: before each write, "free" the status line by making room at
 * the bottom. After the write, redraw the status bar. This avoids flicker
 * and works regardless of how the terminal scrolls.
 */
import { compactNumber, dim, meter, yellow } from "./ansi.ts";
import { getCurrentTheme, themeColorToAnsi, themeColorReset } from "./theme.ts";

export type StatusInfo = {
  provider: string;
  model: string;
  contextUsed: number;
  contextWindow: number;
  mode: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  backendConnection?: string;
  backendSession?: string;
  workers?: string;
  sandbox?: string;
  phase?: string;
  /** 0 = idle, 1 = waiting on model, 2 = tool running */
  busy: 0 | 1 | 2;
  /** Optional wait message when busy */
  wait?: string;
};

export class StatusBar {
  private lastInfo: StatusInfo | null = null;
  private active = false;
  private savedRows = 0;
  private resizeHandler: (() => void) | null = null;

  constructor(private readonly out: NodeJS.WriteStream) {}

  get isActive(): boolean {
    return this.active;
  }

  enable(): void {
    if (this.active || !this.out.isTTY) return;
    this.active = true;
    this.resizeHandler = () => this.redraw();
    this.out.on("resize", this.resizeHandler);
    this.savedRows = this.out.rows || 24;
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.clearLine();
    if (this.resizeHandler) {
      this.out.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  /**
   * Call BEFORE writing content to the terminal.
   * Ensures the status bar line is freed so content doesn't overwrite it.
   */
  protect(): void {
    if (!this.active || !this.out.isTTY) return;
    const rows = this.out.rows || 24;
    // If we haven't accounted for the status bar row yet, or terminal resized
    if (rows !== this.savedRows) {
      this.savedRows = rows;
    }
  }

  /**
   * Update the status bar with new info. Redraws only if the text changed.
   */
  update(info: StatusInfo): void {
    if (!this.active) return;
    const rendered = this.renderText(info);
    if (rendered === this.lastRendered && info.busy === this.lastInfo?.busy) return;
    this.lastRendered = rendered;
    this.lastInfo = info;
    this.redraw();
  }

  private lastRendered = "";

  private redraw(): void {
    if (!this.active || !this.out.isTTY || !this.lastInfo) return;
    const rows = this.out.rows || 24;
    const buf = this.renderText(this.lastInfo);

    // Non-destructive cursor save/restore: save, move to last line,
    // clear it, write status, restore.
    this.out.write(`\x1b7\x1b[${rows};1H\x1b[K${buf}\x1b8`);
  }

  private clearLine(): void {
    if (!this.out.isTTY) return;
    const rows = this.out.rows || 24;
    this.out.write(`\x1b7\x1b[${rows};1H\x1b[K\x1b8`);
  }

  private renderText(info: StatusInfo): string {
    const theme = getCurrentTheme();
    const accent = themeColorToAnsi(theme.ui.accent);
    const muted = themeColorToAnsi(theme.ui.muted);
    const reset = themeColorReset();

    const ctx =
      info.contextWindow > 0
        ? `${meter(info.contextUsed)} ${muted}${compactNumber(info.contextUsed)}${reset}`
        : `${meter(0)}`;

    const busy = info.busy > 0;
    const glyph = busy ? yellow("◐") : accent + "●" + reset;
    const wait = busy && info.wait ? ` ${dim(info.wait)}` : "";

    const parts = [
      glyph,
      accent + info.provider + reset,
      info.backendConnection ? dim(info.backendConnection) : "",
      info.backendSession ? dim(`#${info.backendSession}`) : "",
      info.sandbox ? dim(`sandbox ${info.sandbox}`) : "",
      info.phase && info.phase !== "idle" ? yellow(info.phase) : "",
      info.workers ? dim(`workers ${info.workers}`) : "",
      dim(info.model),
      ctx,
      dim(info.mode),
      `${muted}${compactNumber(info.tokensIn)}/${compactNumber(info.tokensOut)}${reset}`,
      info.costUsd > 0 ? `${muted}$${info.costUsd.toFixed(4)}${reset}` : "",
    ].filter(Boolean);

    return parts.join(` ${muted}·${reset} `) + wait;
  }
}
