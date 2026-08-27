import { themeColorToAnsi, themeColorReset, getCurrentTheme } from "./theme.ts";
import type { SyntaxColors } from "./theme.ts";

const enabled = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;

const wrap = (open: string, close: string) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const italic = wrap("3", "23");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const magenta = wrap("35", "39");
export const cyan = wrap("36", "39");
export const gray = wrap("90", "39");

export const colorsEnabled = enabled;

// ---------------------------------------------------------------------------
// Theme-aware color functions
// ---------------------------------------------------------------------------

/**
 * Apply UI text color from current theme.
 */
export function uiText(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.text)}${s}${themeColorReset()}` : s;
}

/**
 * Apply muted UI color from current theme.
 */
export function uiMuted(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.muted)}${s}${themeColorReset()}` : s;
}

/**
 * Apply success color from current theme.
 */
export function uiSuccess(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.success)}${s}${themeColorReset()}` : s;
}

/**
 * Apply warning color from current theme.
 */
export function uiWarning(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.warning)}${s}${themeColorReset()}` : s;
}

/**
 * Apply error color from current theme.
 */
export function uiError(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.error)}${s}${themeColorReset()}` : s;
}

/**
 * Apply accent color from current theme (for spinners, etc.).
 */
export function uiAccent(s: string): string {
  const theme = getCurrentTheme();
  return enabled ? `${themeColorToAnsi(theme.ui.accent)}${s}${themeColorReset()}` : s;
}

/**
 * Apply syntax highlighting color.
 */
export function syntaxColor(tokenType: keyof SyntaxColors, s: string): string {
  const theme = getCurrentTheme();
  const color = theme.syntax[tokenType];
  return enabled ? `${themeColorToAnsi(color)}${s}${themeColorReset()}` : s;
}

/**
 * An open/close pair, for callers that turn a style on, stream an unknown
 * amount of text, and turn it off later. `wrap` cannot do this: it needs the
 * whole string up front.
 */
export type Style = { on: string; off: string };

export const NO_STYLE: Style = { on: "", off: "" };

export const style = (open: string, close: string): Style =>
  enabled ? { on: `\x1b[${open}m`, off: `\x1b[${close}m` } : NO_STYLE;

/** Strip SGR sequences. Used to reason about text position, not to sanitize. */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Colorize a unified diff produced by core/diff.ts. */
export function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return green(line);
      if (line.startsWith("-")) return red(line);
      if (line === "…") return gray(line);
      return dim(line);
    })
    .join("\n");
}

/**
 * A context meter. Colour is the signal: it only turns yellow/red as the window
 * fills, so a glance is enough.
 */
export function meter(fraction: number, width = 10): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return gray("░".repeat(width));
  const clamped = Math.min(1, fraction);
  const filled = Math.max(1, Math.round(clamped * width));
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  if (clamped >= 0.8) return red(bar);
  if (clamped >= 0.6) return yellow(bar);
  return green(bar);
}

/** 12345 -> "12.3k". Token counts are read at a glance, not audited. */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A spinner that stays on one line and cleans up after itself. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(private readonly stream: NodeJS.WriteStream) {}

  /** A function label is re-read every frame, so it can carry a live clock. */
  start(label: string | (() => string)): void {
    if (!enabled || this.timer) return;
    const text = typeof label === "string" ? () => label : label;
    const paint = () => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.stream.write(`\r${cyan(FRAMES[this.frame]!)} ${text()}\x1b[K`);
    };
    this.stream.write("\x1b[?25l"); // hide cursor
    paint(); // first frame now — a spinner that appears 80ms late looks laggy
    this.timer = setInterval(paint, 80);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write("\r\x1b[K\x1b[?25h"); // clear line, show cursor
  }
}
