import { homedir } from "node:os";
import { bold, cyan, dim, gray, stripAnsi, yellow } from "./ansi.ts";

/**
 * The welcome box, fronted by Rocky the Eridian (Project Hail Mary).
 *
 * Faithful to the book where ASCII allows: a rocky carapace, five radial legs,
 * and no eyes — Eridians perceive by sound, which is also why the mascot's one
 * flourish is a musical note. He speaks in chords; we get "Amaze!".
 *
 * This is a pure function of its inputs so the alignment math is testable.
 * Colour comes from ansi.ts helpers, which are no-ops when output is not a
 * terminal, so tests see plain strings and pipes see nothing weird.
 */

export type BannerInfo = {
  version: string;
  model: string;
  provider: string;
  mode: string;
  cwd: string;
  /** Terminal width. The box never exceeds it. */
  columns?: number;
  /** Injected in tests; defaults to the real home directory. */
  home?: string;
};

const MASCOT = [
  "  ▄▟███▙▄  ",
  " ▐███████▌ ",
  "  ▀▜███▛▀  ",
  "  ╱╱ ┃ ╲╲  ",
] as const;

const MASCOT_WIDTH = 11;
const GAP = "   ";

/** Below this there is no room for a box; fall back to one plain line. */
const MIN_BOX_COLUMNS = 44;

/** Replace the home-directory prefix with `~`, as a human would write it. */
export function tildify(path: string, home: string = homedir()): string {
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Visible length: what the terminal shows, not what the string contains. */
const width = (s: string): number => stripAnsi(s).length;

/** Truncate a styled line to `max` visible columns, ending in `…`. */
function fit(line: string, max: number): string {
  if (width(line) <= max) return line;
  // Rebuild character by character, keeping escape sequences intact but free.
  let visible = 0;
  let out = "";
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (visible >= max - 1) return `${out}…`;
      out += ch;
      visible += 1;
    }
  }
  return out;
}

export function banner(info: BannerInfo): string {
  // A pty whose size was never set reports 0 columns. That means "unknown",
  // not "too narrow" — found live under script(1).
  const columns = info.columns || 80;
  const cwd = tildify(info.cwd, info.home);

  if (columns < MIN_BOX_COLUMNS) {
    return `${cyan(bold("rocky"))} ${dim(`v${info.version} · ${info.model} · ${info.mode} · ${cwd}`)}\n${gray("/help for commands")}`;
  }

  const infoLines = [
    `${cyan(bold("rocky"))} ${dim(`v${info.version}`)}  ${yellow("♫ Amaze!")}`,
    `${info.model}${dim(` · ${info.provider}`)}`,
    `${info.mode}${dim(` · ${cwd}`)}`,
    gray("/help for commands · Esc interrupts · Ctrl-C twice exits"),
  ];

  // Interior: space + mascot + gap + info + space, capped by the terminal.
  const innerMax = columns - 2 - 2 - MASCOT_WIDTH - GAP.length;
  const fitted = infoLines.map((l) => fit(l, innerMax));
  const infoWidth = Math.max(...fitted.map(width));
  const inner = 1 + MASCOT_WIDTH + GAP.length + infoWidth + 1;

  const rows = MASCOT.map((art, i) => {
    const line = fitted[i] ?? "";
    const pad = " ".repeat(infoWidth - width(line));
    return `${dim("│")} ${yellow(art)}${GAP}${line}${pad} ${dim("│")}`;
  });

  return [
    dim(`╭${"─".repeat(inner)}╮`),
    ...rows,
    dim(`╰${"─".repeat(inner)}╯`),
  ].join("\n");
}
