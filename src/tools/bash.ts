import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  fail,
  jsonSchemaOf,
  ok,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.ts";

const schema = z.object({
  command: z.string().min(1).describe("The shell command to run."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds. Defaults to 120000."),
});

type Input = z.infer<typeof schema>;

/**
 * Run the command inside an explicit `cd`, then capture the final working
 * directory. This is what makes `cd src && bun test` persist across calls
 * without keeping a long-lived shell process alive.
 */
function wrap(command: string, cwd: string, pwdFile: string): string {
  return [
    `cd ${shellQuote(cwd)} || exit 1`,
    command,
    `__rocky_exit=$?`,
    `pwd > ${shellQuote(pwdFile)} 2>/dev/null`,
    `exit $__rocky_exit`,
  ].join("\n");
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export type BashOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  newCwd?: string;
};

/** Spawn + timeout + abort. Split out so tests can drive it without a Tool. */
export async function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BashOutcome> {
  const tmp = mkdtempSync(join(tmpdir(), "rocky-"));
  const pwdFile = join(tmp, "pwd");

  const proc = Bun.spawn(["bash", "-c", wrap(command, cwd, pwdFile)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ROCKY: "1" },
    // Its own process group, so a kill reaches grandchildren too. Signalling
    // only `bash` leaves the running child alive holding the stdout pipe open,
    // and reading that pipe would then block until the child finishes anyway.
    detached: true,
  });

  let timedOut = false;
  let aborted = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;

  /** Signal the whole process group; fall back to the leader if that fails. */
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // Already reaped.
      }
    }
  };

  const kill = () => {
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 2000);
    escalation.unref?.();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const onAbort = () => {
    aborted = true;
    kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    let newCwd: string | undefined;
    try {
      const p = readFileSync(pwdFile, "utf8").trim();
      if (p) newCwd = p;
    } catch {
      // Command died before `pwd` ran; keep the old cwd.
    }

    return { stdout, stderr, exitCode, timedOut, aborted, newCwd };
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signal.removeEventListener("abort", onAbort);
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const bashTool: Tool<Input> = {
  name: "bash",
  description: [
    "Run a shell command and return its combined output.",
    "The working directory persists across calls within a session.",
    "Prefer the dedicated read_file / grep / glob tools over cat / grep / find:",
    "they are faster and produce output the agent handles better.",
    "Quote paths that contain spaces.",
  ].join(" "),
  schema,
  jsonSchema: jsonSchemaOf(schema),
  readOnly: false,

  /**
   * Always the command itself, never a model-supplied description. This string
   * is what the user reads when deciding whether to allow the call, and when
   * seeing what was refused; a paraphrase would be worse than useless there.
   */
  summarize: (input) => {
    const first = input.command.split("\n")[0]!;
    const more = input.command.includes("\n") ? " …" : "";
    return `${first.length > 80 ? `${first.slice(0, 79)}…` : first}${more}`;
  },

  /** The permission prompt shows the full command, unabridged. */
  preview: (input) => input.command,

  async run(input, ctx: ToolContext): Promise<ToolResult> {
    const timeout = Math.min(
      input.timeout_ms ?? ctx.config.bashTimeoutMs,
      ctx.config.bashMaxTimeoutMs,
    );

    const r = await runBash(input.command, ctx.cwd, timeout, ctx.signal);
    if (r.newCwd && r.newCwd !== ctx.cwd) ctx.setCwd(r.newCwd);

    const parts: string[] = [];
    if (r.stdout) parts.push(r.stdout.trimEnd());
    if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    // Size is capped centrally, in core/hygiene.ts, for every tool alike.
    const text = parts.join("\n") || "(no output)";

    const meta = { exitCode: r.exitCode, timedOut: r.timedOut, cwd: ctx.cwd };

    if (r.aborted) return fail("Command was interrupted by the user.", meta);
    if (r.timedOut) {
      return fail(
        `Command timed out after ${timeout}ms and was killed.\n\n${text}`,
        meta,
      );
    }
    if (r.exitCode !== 0) {
      return fail(`Exit code ${r.exitCode}\n\n${text}`, meta);
    }
    return ok(text, meta);
  },
};
