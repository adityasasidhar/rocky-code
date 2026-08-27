import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadTask, runTrial, TaskSpecSchema } from "../bench/harness.ts";
import { median, renderTable, summarize } from "../bench/report.ts";
import { parseTrialCount } from "../bench/run.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { MockProvider, text, toolUse } from "./mock_provider.ts";

const TASKS_DIR = join(import.meta.dir, "..", "bench", "tasks");

describe("bench tasks", () => {
  test("every shipped task loads and validates", () => {
    const names = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(names).toEqual([
      "add-feature-with-test",
      "cross-file-rename",
      "fix-failing-test",
    ]);
    for (const name of names) {
      const task = loadTask(join(TASKS_DIR, name));
      expect(task.name).toBe(name);
      expect(task.spec.prompt.length).toBeGreaterThan(10);
      expect(task.spec.verify.length).toBeGreaterThan(3);
    }
  });

  test("a task without a prompt is rejected at the boundary", () => {
    expect(() => TaskSpecSchema.parse({ verify: "true" })).toThrow();
  });
});

describe("bench runner", () => {
  test("trial count defaults to three and rejects invalid values", () => {
    expect(parseTrialCount(undefined)).toBe(3);
    expect(parseTrialCount("5")).toBe(5);
    expect(() => parseTrialCount("0")).toThrow("positive integer");
    expect(() => parseTrialCount("many")).toThrow("positive integer");
  });
});

describe("bench harness", () => {
  // The harness itself is provider-agnostic: a scripted model proves the
  // plumbing (repo seeding, metrics, external verify) without a live model.
  test("a scripted agent that fixes the bug scores a pass, with metrics", async () => {
    const task = loadTask(join(TASKS_DIR, "fix-failing-test"));
    const provider = new MockProvider([
      {
        content: [toolUse("t1", "read_file", { path: "src/math.ts" })],
        stopReason: "tool_use",
      },
      {
        content: [
          toolUse("t2", "edit_file", {
            path: "src/math.ts",
            old_str: "  return a - b;",
            new_str: "  return a + b;",
          }),
        ],
        stopReason: "tool_use",
      },
      { content: [text("Fixed.")], stopReason: "end_turn" },
    ]);

    const result = await runTrial(task, provider, defaultConfig());

    // The verdict came from verify.ts running for real, not from the model.
    expect(result.passed).toBe(true);
    expect(result.verifyOutput).toContain("PASS");
    expect(result.task).toBe("fix-failing-test");
    expect(result.toolCalls).toBe(2);
    expect(result.toolErrors).toBe(0);
    expect(result.turns).toBe(3);
    expect(result.stopReason).toBe("end_turn");
  }, 20_000);

  test("an agent that only talks scores a fail — the transcript is not trusted", async () => {
    const task = loadTask(join(TASKS_DIR, "fix-failing-test"));
    const provider = new MockProvider([
      { content: [text("I fixed the bug, all done!")], stopReason: "end_turn" },
    ]);

    const result = await runTrial(task, provider, defaultConfig());
    expect(result.passed).toBe(false);
    expect(result.verifyOutput).toContain("FAIL");
  }, 20_000);

  test("hidden/ acceptance files are invisible to the agent, present for verify", async () => {
    const task = loadTask(join(TASKS_DIR, "cross-file-rename"));
    const provider = new MockProvider([
      {
        content: [toolUse("t1", "glob", { pattern: "**/*.ts" })],
        stopReason: "tool_use",
      },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const seen: string[] = [];
    const result = await runTrial(task, provider, defaultConfig(), (e) => {
      if (e.type === "tool_end") seen.push(e.result.output);
    });

    // The agent's glob never saw the judge…
    expect(seen.join("\n")).not.toContain("rename_check");
    // …but the judge ran (and failed this lazy agent).
    expect(result.passed).toBe(false);
  }, 20_000);
});

describe("bench report", () => {
  const trial = (task: string, passed: boolean, turns: number) => ({
    task,
    passed,
    turns,
    toolCalls: turns * 2,
    toolErrors: passed ? 0 : 1,
    denied: 0,
    durationMs: 1000 * turns,
    inputTokens: 100,
    outputTokens: 50,
    stopReason: "end_turn",
    verifyOutput: "",
  });

  test("median is boring and correct", () => {
    expect(median([])).toBe(0);
    expect(median([3])).toBe(3);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("summarize groups by task and counts passes", () => {
    const s = summarize([
      trial("a", true, 4),
      trial("a", false, 8),
      trial("a", true, 6),
      trial("b", true, 2),
    ]);
    expect(s).toHaveLength(2);
    const a = s.find((x) => x.task === "a")!;
    expect(a.passed).toBe(2);
    expect(a.trials).toBe(3);
    expect(a.medianTurns).toBe(6);
  });

  test("the table lines up and totals honestly", () => {
    const out = renderTable(summarize([trial("a", true, 4), trial("b", false, 2)]));
    expect(out).toContain("a");
    expect(out).toContain("1/1");
    expect(out).toContain("0/1");
    expect(out).toContain("1/2 trials passed");
  });
});
