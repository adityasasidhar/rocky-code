import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { createProvider } from "../src/core/provider/index.ts";
import { loadTask, runTrial, type TrialResult } from "./harness.ts";
import { renderTable, summarize } from "./report.ts";

const PROJECT_DIR = join(import.meta.dir, "..");
const TASKS_DIR = join(import.meta.dir, "tasks");

export function parseTrialCount(raw: string | undefined): number {
  if (raw === undefined) return 3;
  const count = Number(raw);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("ROCKY_BENCH_TRIALS must be a positive integer");
  }
  return count;
}

export async function main(): Promise<void> {
  const trials = parseTrialCount(process.env.ROCKY_BENCH_TRIALS);
  const { config } = loadConfig(PROJECT_DIR, { backend: "local" });
  const provider = createProvider(config.provider);
  await provider.prepare?.(config.model, new AbortController().signal);

  const tasks = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadTask(join(TASKS_DIR, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results: TrialResult[] = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= trials; trial++) {
      process.stderr.write(`[bench] ${task.name} ${trial}/${trials}\n`);
      results.push(await runTrial(task, provider, config));
    }
  }

  process.stdout.write(renderTable(summarize(results)));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`bench failed: ${message}\n`);
    process.exitCode = 1;
  });
}
