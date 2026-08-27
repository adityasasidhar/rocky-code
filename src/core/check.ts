import type { Config } from "../config/schema.ts";
import { runBash } from "../tools/bash.ts";
import { truncateMiddle } from "./truncate.ts";

/**
 * The post-edit check: the project's own fast gate (typecheck, lint), run
 * after any batch that changed a file, with failures fed straight back to the
 * model. The edit itself is never marked failed — it landed; the check is
 * information about what it broke, delivered while the model can still act
 * on it cheaply.
 */

export type CheckConfig = NonNullable<Config["check"]>;

export type CheckOutcome =
  /** Exit 0: say nothing to the model — the happy path costs zero tokens. */
  | { kind: "pass" }
  /** The check ran and failed: feedback for the model, a summary for the TUI. */
  | { kind: "fail"; feedback: string; summary: string }
  /** The check *itself* cannot run. Tell the user once, then stop trying. */
  | { kind: "broken"; notice: string };

export async function runCheck(
  cfg: CheckConfig,
  projectDir: string,
  signal: AbortSignal,
): Promise<CheckOutcome> {
  let out;
  try {
    out = await runBash(cfg.command, projectDir, cfg.timeoutMs, signal);
  } catch (e) {
    return {
      kind: "broken",
      notice: `post-edit check could not run (${(e as Error).message}); disabled for this session.`,
    };
  }

  if (out.aborted) return { kind: "pass" }; // the turn is over; nobody to tell
  if (out.exitCode === 0 && !out.timedOut) return { kind: "pass" };

  // 127/126 is "command not found / not executable": a broken config, not a
  // broken edit. Feeding it to the model would send it fixing the wrong thing
  // forever, and re-running it would tax every batch.
  if (out.exitCode === 127 || out.exitCode === 126) {
    return {
      kind: "broken",
      notice:
        `post-edit check \`${cfg.command}\` is not runnable (exit ${out.exitCode}); ` +
        `disabled for this session. Fix \`check.command\` in .rocky/config.json.`,
    };
  }

  const combined = [out.stdout, out.stderr ? `[stderr]\n${out.stderr}` : ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  const { text } = truncateMiddle(combined, cfg.maxOutputBytes);

  const status = out.timedOut
    ? `timed out after ${cfg.timeoutMs}ms`
    : `exit ${out.exitCode}`;
  const feedback = [
    "<post_edit_check>",
    "The edit was applied, but the project's check command now fails.",
    `Command: ${cfg.command} (${status})`,
    "",
    text || "(no output)",
    "",
    "Fix these failures before doing anything else. Do not re-apply the edit — it is already in the file.",
    "</post_edit_check>",
  ].join("\n");

  const summary =
    firstMeaningfulLine(text) ?? (out.timedOut ? "timed out" : `exit ${out.exitCode}`);
  return { kind: "fail", feedback, summary };
}

/** The line a human would read first: the first non-blank one. */
function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
  }
  return undefined;
}
