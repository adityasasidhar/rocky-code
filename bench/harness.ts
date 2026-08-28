import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import type { Config } from "../src/config/schema.ts";
import {
  runTurn,
  type LoopDeps,
  type LoopEvent,
} from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import type { Provider } from "../src/core/types.ts";
import { builtinTools, makeRegistry } from "../src/tools/index.ts";

const DEFAULT_TRIAL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_VERIFY_OUTPUT_BYTES = 128 * 1024;
const PATH_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
]);
const DISABLED_BENCH_TOOLS = new Set(["bash", "task"]);

export const TaskSpecSchema = z
  .object({
    prompt: z.string().trim().min(1),
    verify: z.string().trim().min(1),
  })
  .strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export type BenchTask = {
  name: string;
  root: string;
  repoDir: string;
  hiddenDir: string;
  spec: TaskSpec;
};

export type TrialResult = {
  task: string;
  passed: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  denied: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  verifyOutput: string;
};

export type TrialOptions = {
  trialTimeoutMs?: number;
  verifyTimeoutMs?: number;
  verifyOutputBytes?: number;
};

export function loadTask(root: string): BenchTask {
  const specPath = join(root, "spec.json");
  const spec = TaskSpecSchema.parse(JSON.parse(readFileSync(specPath, "utf8")));
  const repoDir = join(root, "repo");
  if (!existsSync(repoDir)) throw new Error(`${root}: missing repo/ fixture`);
  return {
    name: basename(root),
    root,
    repoDir,
    hiddenDir: join(root, "hidden"),
    spec,
  };
}

export async function runTrial(
  task: BenchTask,
  provider: Provider,
  config: Config,
  onEvent?: (event: LoopEvent) => void,
  options: TrialOptions = {},
): Promise<TrialResult> {
  const trialTimeoutMs = positiveOption(
    options.trialTimeoutMs,
    DEFAULT_TRIAL_TIMEOUT_MS,
    "trialTimeoutMs",
  );
  const verifyTimeoutMs = positiveOption(
    options.verifyTimeoutMs,
    DEFAULT_VERIFY_TIMEOUT_MS,
    "verifyTimeoutMs",
  );
  const verifyOutputBytes = positiveOption(
    options.verifyOutputBytes,
    DEFAULT_VERIFY_OUTPUT_BYTES,
    "verifyOutputBytes",
  );
  const repo = mkdtempSync(join(tmpdir(), "rocky-bench-"));
  const startedAt = performance.now();
  const controller = new AbortController();
  let trialTimedOut = false;
  const trialTimer = setTimeout(() => {
    trialTimedOut = true;
    controller.abort();
  }, trialTimeoutMs);
  trialTimer.unref?.();

  try {
    copyContents(task.repoDir, repo);
    Bun.spawnSync(["git", "init", "--quiet"], {
      cwd: repo,
      stdout: "ignore",
      stderr: "ignore",
    });

    const session = new Session({ cwd: repo, config, provider, projectDir: repo });
    let toolCalls = 0;
    let toolErrors = 0;
    let denied = 0;
    let stopReason = "aborted";

    try {
      for await (const event of runTurn(
        session,
        task.spec.prompt,
        {
          registry: makeRegistry(builtinTools),
          approve: createBenchApprover(repo),
          subAgents: false,
        },
        controller.signal,
      )) {
        onEvent?.(event);
        if (event.type === "tool_start") toolCalls++;
        if (event.type === "tool_end" && event.result.isError) toolErrors++;
        if (event.type === "tool_denied") denied++;
        if (event.type === "turn_end") stopReason = event.stopReason;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      stopReason = "aborted";
    }

    if (trialTimedOut) {
      return {
        task: task.name,
        passed: false,
        turns: session.turns,
        toolCalls,
        toolErrors,
        denied,
        durationMs: performance.now() - startedAt,
        inputTokens: session.totalUsage.inputTokens,
        outputTokens: session.totalUsage.outputTokens,
        stopReason,
        verifyOutput: `FAIL\nTrial timed out after ${trialTimeoutMs}ms.`,
      };
    }

    // The judge is deliberately absent while the agent works. Only the
    // external verifier receives the hidden overlay after the turn ends.
    if (existsSync(task.hiddenDir)) copyContents(task.hiddenDir, repo);
    const verification = await verify(
      task.spec.verify,
      repo,
      verifyTimeoutMs,
      verifyOutputBytes,
      controller.signal,
    );

    return {
      task: task.name,
      passed:
        !verification.timedOut &&
        !verification.aborted &&
        verification.exitCode === 0,
      turns: session.turns,
      toolCalls,
      toolErrors,
      denied,
      durationMs: performance.now() - startedAt,
      inputTokens: session.totalUsage.inputTokens,
      outputTokens: session.totalUsage.outputTokens,
      stopReason,
      verifyOutput: verification.output,
    };
  } finally {
    clearTimeout(trialTimer);
    controller.abort();
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * Benchmark turns deliberately keep the normal tool ordering, but add a hard
 * capability boundary: no model-controlled shell/sub-agent process and no
 * filesystem target outside the disposable fixture (including symlink exits).
 */
export function createBenchApprover(
  workspace: string,
): NonNullable<LoopDeps["approve"]> {
  const root = realpathSync(workspace);
  return async (tool, input) => {
    if (DISABLED_BENCH_TOOLS.has(tool.name)) {
      return {
        allow: false,
        reason: `benchmark workspace boundary: ${tool.name} is disabled`,
      };
    }

    if (!PATH_TOOLS.has(tool.name)) return { allow: true };
    const requested = requestedPaths(tool.name, input);
    if (requested.some((path) => !pathStaysInside(root, path))) {
      return {
        allow: false,
        reason: "benchmark workspace boundary: paths must stay inside the disposable fixture",
      };
    }
    return { allow: true };
  };
}

function copyContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(destination, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

type Verification = {
  exitCode: number;
  output: string;
  timedOut: boolean;
  aborted: boolean;
};

async function verify(
  command: string,
  cwd: string,
  timeoutMs: number,
  outputBytes: number,
  signal: AbortSignal,
): Promise<Verification> {
  const child = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });

  let timedOut = false;
  let aborted = false;
  let terminating = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;

  const signalGroup = (childSignal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, childSignal);
    } catch {
      try {
        child.kill(childSignal);
      } catch {
        // The process has already been reaped.
      }
    }
  };
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 2_000);
    escalation.unref?.();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => {
    aborted = true;
    terminate();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    // Split the budget so stdout and stderr cannot race each other into an
    // aggregate allocation above the configured cap. Both streams continue
    // to be drained after the cap, preventing a noisy child from blocking.
    const streamBudget = Math.max(1, Math.floor(outputBytes / 2));
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(child.stdout, streamBudget),
      readCapped(child.stderr, streamBudget),
      child.exited,
    ]);
    const parts = [stdout.text, stderr.text].filter(Boolean);
    if (stdout.truncated || stderr.truncated) {
      parts.push(`[verifier output truncated at ${outputBytes} bytes]`);
    }
    const captured = parts.join("\n").trim();
    const reason = timedOut
      ? `Verifier timed out after ${timeoutMs}ms and was killed.`
      : aborted
        ? "Verifier was aborted by the total trial deadline."
        : undefined;
    const failed = reason !== undefined || exitCode !== 0;
    return {
      exitCode,
      output: failed
        ? `FAIL\n${[reason, captured].filter(Boolean).join("\n")}`
        : captured,
      timedOut,
      aborted,
    };
  } finally {
    clearTimeout(timer);
    // The awaited promises above resolve once the group *leader* exits and its
    // pipes close. A descendant that ignores SIGTERM and redirects the pipes it
    // inherited satisfies both conditions while still running, so cancelling the
    // pending escalation here would let it outlive the trial and its temporary
    // repository. Sweep the group with SIGKILL instead of clearing the timer:
    // the SIGTERM grace already elapsed while we waited for the leader, and the
    // group id stays valid for surviving members after the leader is reaped.
    if (escalation) clearTimeout(escalation);
    if (terminating) signalGroup("SIGKILL");
    signal.removeEventListener("abort", onAbort);
  }
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let captured = 0;
  let seen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (captured >= maxBytes) continue;
    const remaining = maxBytes - captured;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const kept = chunk.subarray(0, remaining);
    chunks.push(kept);
    captured += kept.byteLength;
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated: seen > captured,
  };
}

function requestedPaths(toolName: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const value = (input as Record<string, unknown>)["path"];
  const paths = [typeof value === "string" ? value : "."];
  if (toolName === "glob") {
    const pattern = (input as Record<string, unknown>)["pattern"];
    if (typeof pattern === "string") paths.push(pattern);
  }
  return paths;
}

function pathStaysInside(root: string, requested: string): boolean {
  const target = resolve(root, requested);
  if (!contains(root, target)) return false;

  // Existing symlink targets, and the closest existing parent for new files,
  // must resolve inside the fixture as well.
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    return contains(root, realpathSync(existing));
  } catch {
    return false;
  }
}

function contains(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function positiveOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}
