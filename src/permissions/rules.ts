import { basename, expandFlags, parseCommand, type Segment } from "./parse.ts";

/**
 * A rule is written the way a user thinks about a command: `git status`,
 * `bun test`, `rm -rf`, `git push --force`.
 *
 * Matching is structural, not textual:
 *   - the executable must match (by basename, so `/bin/rm` matches `rm`)
 *   - the rule's positional arguments must be a *prefix* of the command's,
 *     so `bun test` allows `bun test src/x` but not `bun run x`
 *   - the rule's flags must be *present anywhere*, because flag order is free:
 *     `git push --force` matches `git push origin main --force`
 */
export type Rule = {
  source: string;
  command: string;
  positionals: string[];
  flags: string[];
};

export function parseRule(source: string): Rule {
  const { segments } = parseCommand(source);
  const tokens = segments[0]?.tokens ?? [];
  if (tokens.length === 0) {
    throw new Error(`Empty permission rule: ${JSON.stringify(source)}`);
  }
  const { positionals, flags } = expandFlags(tokens.slice(1));
  return {
    source: source.trim(),
    command: basename(tokens[0]!),
    positionals,
    flags: [...flags],
  };
}

export function parseRules(sources: readonly string[]): Rule[] {
  return sources.filter((s) => s.trim()).map(parseRule);
}

/** Does this rule cover this single command segment? */
export function ruleMatches(rule: Rule, segment: Segment): boolean {
  const tokens = segment.tokens;
  if (tokens.length === 0) return false;
  if (basename(tokens[0]!) !== rule.command) return false;

  const { positionals, flags } = expandFlags(tokens.slice(1));

  // Rule positionals must prefix the command's positionals.
  if (rule.positionals.length > positionals.length) return false;
  for (let i = 0; i < rule.positionals.length; i++) {
    if (rule.positionals[i] !== positionals[i]) return false;
  }

  // Rule flags must all be present.
  return rule.flags.every((f) => flags.has(f));
}

/** The first rule that covers this segment, if any. */
export const findMatch = (rules: readonly Rule[], segment: Segment): Rule | undefined =>
  rules.find((r) => ruleMatches(r, segment));

/** Commands that run another command, and would otherwise mask it from a rule. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nice",
  "nohup",
  "time",
  "command",
  "xargs",
  "timeout",
]);

/**
 * When a segment is wrapped (`sudo`, `env`, `timeout`, …), yield every suffix
 * of its argv so the real command can be found no matter how the wrapper's own
 * options are shaped. `sudo -u root rm -rf /` defeats any "skip the flags"
 * heuristic — `root` is a value, not a flag — but one of its suffixes is
 * exactly `rm -rf /`.
 *
 * Only wrappers get this treatment, so `echo rm -rf /` is not mistaken for a
 * deletion. Used for **deny** matching only: allow matching uses the raw
 * segment, because a rule for `bun test` must never bless `sudo bun test`.
 */
export function unwrapCandidates(segment: Segment): Segment[] {
  const tokens = segment.tokens;
  if (!WRAPPERS.has(basename(tokens[0] ?? ""))) return [];
  const out: Segment[] = [];
  for (let i = 1; i < tokens.length; i++) {
    out.push({ ...segment, tokens: tokens.slice(i) });
  }
  return out;
}

/**
 * Commands so destructive that they are refused in every mode, including yolo.
 * Deliberately tiny: this is a backstop against catastrophe, not a policy
 * engine. Everything debatable belongs in the user's `deny` config.
 */
export const BUILTIN_DENY: readonly string[] = [
  "rm -rf /",
  "rm -fr /",
  "mkfs",
  "dd of=/dev/sda",
  "shutdown",
  "reboot",
];

export type BashVerdict =
  | { kind: "deny"; rule: Rule; segment: Segment }
  | { kind: "allow" }
  | { kind: "ask"; reason: "no-rule" | "dynamic" | "redirect" };

/**
 * Evaluate a whole command line.
 *
 * A denial anywhere denies the whole line — `bun test && rm -rf /` is not a
 * test run. An allow requires *every* segment to be allowed, and any segment
 * the shell could rewrite (`$(...)`, `eval`) forces a prompt no matter what
 * the allowlist says.
 */
export function evaluateBash(
  command: string,
  allow: readonly Rule[],
  deny: readonly Rule[],
): BashVerdict {
  const { segments } = parseCommand(command);
  if (segments.length === 0) return { kind: "ask", reason: "no-rule" };

  for (const segment of segments) {
    // Deny sees through wrappers; allow (below) does not.
    const denied =
      findMatch(deny, segment) ??
      unwrapCandidates(segment)
        .map((c) => findMatch(deny, c))
        .find(Boolean);
    if (denied) return { kind: "deny", rule: denied, segment };
  }

  for (const segment of segments) {
    if (segment.dynamic) return { kind: "ask", reason: "dynamic" };
    // Writing a file is a capability the rule never granted: `bun test` must
    // not imply `bun test > /etc/passwd`.
    if (segment.redirectsOutput) return { kind: "ask", reason: "redirect" };
    if (!findMatch(allow, segment)) return { kind: "ask", reason: "no-rule" };
  }
  return { kind: "allow" };
}

/**
 * The rule Rocky would add if the user answers "always allow".
 *
 * Narrow on purpose: `git status --short` grants `git status`, not `git`.
 * A single-segment command grants its executable plus its first positional;
 * multi-segment lines grant nothing automatically, because the user would be
 * blessing a compound they did not read as a unit.
 */
export function suggestRule(command: string): string | undefined {
  const { segments } = parseCommand(command);
  if (segments.length !== 1) return undefined;
  const segment = segments[0]!;
  if (segment.dynamic) return undefined;

  const tokens = segment.tokens;
  if (tokens.length === 0) return undefined;

  const exe = basename(tokens[0]!);
  const { positionals } = expandFlags(tokens.slice(1));
  const sub = positionals[0];
  // A subcommand-style first positional (`git status`) is worth including;
  // a path or filename (`cat notes.txt`) is not.
  return sub && /^[a-z][\w-]*$/i.test(sub) && !sub.includes(".")
    ? `${exe} ${sub}`
    : exe;
}
