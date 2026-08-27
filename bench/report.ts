import type { TrialResult } from "./harness.ts";

export type TaskSummary = {
  task: string;
  passed: number;
  trials: number;
  medianTurns: number;
  medianToolCalls: number;
  medianDurationMs: number;
  toolErrors: number;
};

export function median(_values: readonly number[]): number {
  if (_values.length === 0) return 0;
  const values = [..._values].sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle]!;
  return (values[middle - 1]! + values[middle]!) / 2;
}

export function summarize(_results: readonly TrialResult[]): TaskSummary[] {
  const grouped = new Map<string, TrialResult[]>();
  for (const result of _results) {
    const group = grouped.get(result.task) ?? [];
    group.push(result);
    grouped.set(result.task, group);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([task, results]) => ({
      task,
      passed: results.filter((result) => result.passed).length,
      trials: results.length,
      medianTurns: median(results.map((result) => result.turns)),
      medianToolCalls: median(results.map((result) => result.toolCalls)),
      medianDurationMs: median(results.map((result) => result.durationMs)),
      toolErrors: results.reduce((sum, result) => sum + result.toolErrors, 0),
    }));
}

export function renderTable(_summaries: readonly TaskSummary[]): string {
  const taskWidth = Math.max("task".length, ..._summaries.map((summary) => summary.task.length));
  const rows = [
    `${"task".padEnd(taskWidth)}  pass  turns  tools  errors  median`,
    `${"-".repeat(taskWidth)}  ----  -----  -----  ------  ------`,
    ..._summaries.map(
      (summary) =>
        `${summary.task.padEnd(taskWidth)}  ${`${summary.passed}/${summary.trials}`.padStart(4)}  ${String(summary.medianTurns).padStart(5)}  ${String(summary.medianToolCalls).padStart(5)}  ${String(summary.toolErrors).padStart(6)}  ${formatDuration(summary.medianDurationMs).padStart(6)}`,
    ),
  ];
  const passed = _summaries.reduce((sum, summary) => sum + summary.passed, 0);
  const trials = _summaries.reduce((sum, summary) => sum + summary.trials, 0);
  rows.push("", `${passed}/${trials} trials passed`);
  return `${rows.join("\n")}\n`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
