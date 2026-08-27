import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Config } from "../src/config/schema.ts";
import { runTurn, type LoopEvent } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import type { Provider } from "../src/core/types.ts";
import { builtinTools, makeRegistry } from "../src/tools/index.ts";

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
): Promise<TrialResult> {
  const repo = mkdtempSync(join(tmpdir(), "rocky-bench-"));
  const startedAt = performance.now();

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

    for await (const event of runTurn(
      session,
      task.spec.prompt,
      { registry: makeRegistry(builtinTools) },
      new AbortController().signal,
    )) {
      onEvent?.(event);
      if (event.type === "tool_start") toolCalls++;
      if (event.type === "tool_end" && event.result.isError) toolErrors++;
      if (event.type === "tool_denied") denied++;
      if (event.type === "turn_end") stopReason = event.stopReason;
    }

    // The judge is deliberately absent while the agent works. Only the
    // external verifier receives the hidden overlay after the turn ends.
    if (existsSync(task.hiddenDir)) copyContents(task.hiddenDir, repo);
    const verification = await verify(task.spec.verify, repo);

    return {
      task: task.name,
      passed: verification.exitCode === 0,
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
    rmSync(repo, { recursive: true, force: true });
  }
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

async function verify(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const output = `${stdout}${stderr}`.trim();
  return {
    exitCode,
    output: exitCode === 0 ? output : `FAIL\n${output}`,
  };
}
