/**
 * The input line's brains: slash commands, Tab completion, type-ahead, and
 * history persistence. Everything here is a pure function over strings —
 * cli.ts wires them to readline and the filesystem.
 */

export type SlashCommand = {
  /** What the user types (and what Tab completes). */
  name: string;
  /** How /help shows it, arguments included. */
  usage: string;
  what: string;
};

/**
 * The one table every consumer reads: /help renders it, Tab completes from it,
 * and unknownCommand() checks against it. A command added here is everywhere.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/sessions", usage: "/sessions", what: "list persisted TrueForge sessions" },
  { name: "/workers", usage: "/workers", what: "show worker health and recommendations" },
  { name: "/worker", usage: "/worker <name|auto>", what: "override worker selection" },
  { name: "/sandbox", usage: "/sandbox", what: "show TrueForge and Daytona state" },
  { name: "/heal", usage: "/heal", what: "ask Rocky to diagnose and recover" },
  { name: "/diff", usage: "/diff", what: "show the current workspace diff summary" },
  { name: "/undo", usage: "/undo", what: "approval-gated restore of the latest checkpoint" },
  { name: "/doctor", usage: "/doctor", what: "run environment and isolation checks" },
  { name: "/plan", usage: "/plan", what: "toggle plan mode: read-only until you approve" },
  { name: "/cost", usage: "/cost", what: "token and cost breakdown" },
  { name: "/compact", usage: "/compact", what: "summarize the conversation now" },
  { name: "/model", usage: "/model [id]", what: "show or switch the model" },
  { name: "/expand", usage: "/expand <n>", what: "reprint a collapsed tool result in full" },
  { name: "/permissions", usage: "/permissions", what: "show the active mode and rules" },
  { name: "/info", usage: "/info", what: "session info dashboard" },
  { name: "/clear", usage: "/clear", what: "clear history" },
  { name: "/history", usage: "/history", what: "scroll through this session's output" },
  { name: "/help", usage: "/help", what: "this list" },
  { name: "/exit", usage: "/exit", what: "quit (also /quit or Ctrl-D)" },
];

/** Accepted but not advertised: aliases live here, not in the help table. */
const KNOWN = new Set([...SLASH_COMMANDS.map((c) => c.name), "/quit"]);

/**
 * readline completer. Tab on a partial command fills it in; anywhere else the
 * key does nothing. Arguments never complete — they are paths, model ids, and
 * numbers we cannot guess.
 */
export function completeSlash(line: string): [string[], string] {
  if (!line.startsWith("/") || line.includes(" ")) return [[], line];
  const hits = [...KNOWN].filter((name) => name.startsWith(line)).sort();
  return [hits, line];
}

/**
 * A lone `/word` that is not a command is almost certainly a typo'd command,
 * not prose. Catching it saves a model round-trip that could only shrug — and
 * worse, `/cmpact` sent to the model reads like permission to keep going.
 * Returns the offending token, or undefined when the input is fine as prose.
 * Paths pass through: `/etc/hosts` has a second `/` and never matches.
 */
export function unknownCommand(input: string): string | undefined {
  const first = input.split(/\s+/, 1)[0] ?? "";
  if (!/^\/[a-z-]+$/.test(first)) return undefined;
  return KNOWN.has(first) ? undefined : first;
}

/**
 * What the user typed while a turn was running, decoded into intent.
 *
 * Raw mode gives us bytes, not lines: escape sequences from arrow keys,
 * backspaces from corrections, Enters from submitted thoughts. Completed
 * lines become queued prompts; the unfinished tail goes back into the editor
 * so the user continues where they left off.
 */
export function splitTypeAhead(raw: string): { lines: string[]; partial: string } {
  const stripped = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z~]/g, "") // CSI: arrows, Home, Del, PgUp…
    .replace(/\x1b[NO]./g, "") // SS2/SS3: F1–F4
    .replace(/\x1b/g, ""); // any stray escape byte

  const lines: string[] = [];
  let current = "";
  for (const ch of stripped) {
    if (ch === "\r" || ch === "\n") {
      if (current.trim()) lines.push(current);
      current = "";
    } else if (ch === "\x7f" || ch === "\b") {
      current = current.slice(0, -1); // honor the user's own corrections
    } else if (ch >= " " || ch === "\t") {
      current += ch;
    }
    // Every other control character is dropped: it meant something to a
    // terminal, not to the conversation.
  }
  return { lines, partial: current };
}

export const HISTORY_LIMIT = 1000;

/**
 * History file → readline's `history` option, which wants most-recent-first.
 * The file is oldest-first so a tail of it reads like a session log.
 */
export function parseHistory(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-HISTORY_LIMIT)
    .reverse();
}

/** readline history → file contents, oldest first, capped, newline-terminated. */
export function serializeHistory(history: string[]): string {
  const chrono = history
    .filter((line) => line.trim().length > 0)
    .slice(0, HISTORY_LIMIT)
    .reverse();
  return chrono.length > 0 ? `${chrono.join("\n")}\n` : "";
}
