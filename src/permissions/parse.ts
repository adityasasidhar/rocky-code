/**
 * A shell-command parser good enough to make safety decisions on.
 *
 * We never match rules against the raw string. `rm -rf /` and
 * `echo hi && rm -rf /` and `rm    -rf  /` must all reach the same verdict, and
 * `echo "rm -rf /"` must not. That requires tokenizing and splitting on real
 * operators, respecting quotes.
 *
 * Where the shell can produce a command we cannot see — `$(...)`, backticks,
 * `eval`, process substitution — the segment is marked `dynamic`. Dynamic
 * segments can never be auto-allowed; they always fall through to a prompt.
 */

export type Segment = {
  /** Argv-style tokens with quotes and redirections removed. */
  tokens: string[];
  /** The literal source text of this segment, for display. */
  raw: string;
  /** True when the shell could expand this into something else entirely. */
  dynamic: boolean;
  /**
   * True when the segment writes to a file (`>`, `>>`, `&>`).
   *
   * This is a distinct capability from the command itself: a rule allowing
   * `bun test` must not thereby allow `bun test > /etc/passwd`. File-descriptor
   * duplication (`2>&1`) and input redirection (`< file`) do not set this.
   */
  redirectsOutput: boolean;
};

export type ParsedCommand = {
  segments: Segment[];
  /** True if any segment is dynamic. */
  dynamic: boolean;
};

/** Operators that separate one command from the next. */
const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "\n"];

/**
 * A redirection, optionally preceded by a file descriptor and followed by a
 * duplication target: `>`, `>>`, `2>`, `&>`, `2>&1`, `<`, `<<`, `<<<`.
 * Matched *before* operators, so the `&` in `2>&1` is never read as background.
 */
const REDIRECT = /^(\d*)(>>|>&|&>|<<<|<<|<&|>|<)(&?\d*)/;
/** Same, but with no leading fd, for when we're in the middle of a token. */
const REDIRECT_MIDTOKEN = /^(>>|>&|&>|<<<|<<|<&|>|<)(&?\d*)/;

/** `2>&1` and `>&2` duplicate a descriptor; they do not create a file. */
const isFdDup = (text: string): boolean => /[<>]&\d*$/.test(text);
const writesFile = (text: string): boolean => !isFdDup(text) && text.includes(">");

/** Constructs whose expansion we cannot predict. */
const DYNAMIC_MARKERS = ["$(", "`", "<(", ">("];
const DYNAMIC_COMMANDS = new Set(["eval", "exec", "source", "."]);

export function parseCommand(command: string): ParsedCommand {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let rawStart = 0;
  let redirectsOutput = false;
  let i = 0;

  const pushToken = () => {
    if (hasCurrent) {
      tokens.push(current);
      current = "";
      hasCurrent = false;
    }
  };

  const pushSegment = (end: number) => {
    pushToken();
    const raw = command.slice(rawStart, end).trim();
    if (tokens.length > 0) segments.push(makeSegment(tokens, raw, redirectsOutput));
    tokens = [];
    redirectsOutput = false;
    rawStart = end + 1;
  };

  while (i < command.length) {
    const ch = command[i]!;

    // Quoted spans: contents are literal, never operators.
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const close = end === -1 ? command.length : end;
      current += command.slice(i + 1, close);
      hasCurrent = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) j++;
        j++;
      }
      current += command.slice(i + 1, Math.min(j, command.length)).replace(/\\(.)/g, "$1");
      hasCurrent = true;
      i = j + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // A backslash-newline is a line continuation, not a token character.
      if (command[i + 1] === "\n") {
        i += 2;
        continue;
      }
      current += command[i + 1];
      hasCurrent = true;
      i += 2;
      continue;
    }

    // Redirections are matched before operators so `2>&1` is not split on `&`.
    // They are consumed and dropped: a redirection is not an argument.
    const rest = command.slice(i);
    const redirect = (hasCurrent ? REDIRECT_MIDTOKEN : REDIRECT).exec(rest);
    if (redirect) {
      pushToken();
      if (writesFile(redirect[0])) redirectsOutput = true;
      i += redirect[0].length;
      continue;
    }

    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) {
      pushSegment(i);
      rawStart = i + op.length;
      i += op.length;
      continue;
    }

    if (ch === " " || ch === "\t") {
      pushToken();
      i++;
      continue;
    }

    current += ch;
    hasCurrent = true;
    i++;
  }
  pushSegment(command.length);

  return { segments, dynamic: segments.some((s) => s.dynamic) };
}

function makeSegment(tokens: string[], raw: string, redirectsOutput: boolean): Segment {
  const dynamic =
    DYNAMIC_MARKERS.some((m) => raw.includes(m)) ||
    DYNAMIC_COMMANDS.has(basename(tokens[0] ?? ""));
  return { tokens, raw, dynamic, redirectsOutput };
}

export const basename = (p: string): string => p.split("/").pop() ?? p;

/**
 * Split a token into its comparable form.
 *
 * `-rf` is `-r` and `-f`; `--depth=1` is `--depth`. Without this, a deny rule
 * for `rm -rf` misses `rm -r -f`, and one for `git push --force` misses
 * `git push --force=true`.
 */
export function expandFlags(tokens: string[]): { positionals: string[]; flags: Set<string> } {
  const positionals: string[] = [];
  const flags = new Set<string>();

  for (const token of tokens) {
    if (token === "--") continue;
    if (token.startsWith("--")) {
      flags.add(token.split("=")[0]!);
    } else if (token.startsWith("-") && token.length > 1) {
      // Bundled short flags decompose: `-rf` is exactly `-r -f`. The bundle
      // itself is NOT added, or a rule written `rm -rf` would fail to match
      // the equivalent `rm -r -f`.
      for (const ch of token.split("=")[0]!.slice(1)) flags.add(`-${ch}`);
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}
