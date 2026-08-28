import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  loadTask,
  runTrial,
  TaskSpecSchema,
  type BenchTask,
} from "../bench/harness.ts";
import { median, renderTable, summarize } from "../bench/report.ts";
import { parsePositiveInteger, parseTrialCount } from "../bench/run.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { cleanup, tempDir } from "./helpers.ts";
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

  test("deadline and output-limit environment values require positive integers", () => {
    expect(parsePositiveInteger(undefined, "LIMIT", 42)).toBe(42);
    expect(parsePositiveInteger("250", "LIMIT", 42)).toBe(250);
    expect(() => parsePositiveInteger("-1", "LIMIT", 42)).toThrow(
      "LIMIT must be a positive integer",
    );
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

  test("a stalled provider is aborted at the total trial deadline", async () => {
    const root = tempDir();
    try {
      const task = makeTask(root, "true");
      const provider = new MockProvider(
        [{ content: [text("too late")], stopReason: "end_turn" }],
        { onStream: () => new Promise((resolve) => setTimeout(resolve, 50)) },
      );

      const result = await runTrial(task, provider, defaultConfig(), undefined, {
        trialTimeoutMs: 5,
        verifyTimeoutMs: 100,
      });

      expect(result.passed).toBe(false);
      expect(result.stopReason).toBe("aborted");
      expect(result.verifyOutput).toContain("Trial timed out");
    } finally {
      cleanup(root);
    }
  });

  test("a hanging verifier is killed and scored as a failure", async () => {
    const root = tempDir();
    try {
      const task = makeTask(root, "sleep 0.1");
      const provider = new MockProvider([
        { content: [text("done")], stopReason: "end_turn" },
      ]);

      const result = await runTrial(task, provider, defaultConfig(), undefined, {
        trialTimeoutMs: 1_000,
        verifyTimeoutMs: 10,
      });

      expect(result.passed).toBe(false);
      expect(result.verifyOutput).toContain("Verifier timed out");
    } finally {
      cleanup(root);
    }
  });

  test("a SIGTERM-ignoring descendant does not outlive the verifier", async () => {
    const root = tempDir();
    try {
      const pidFile = join(root, "survivor.pid");
      // The descendant redirects the pipes it inherited and ignores SIGTERM, so
      // the leader's exit closes stdout/stderr and resolves every promise the
      // verifier awaits while this process is still running. Only an explicit
      // SIGKILL sweep of the group reaps it.
      const task = makeTask(
        root,
        `bash -c 'trap "" TERM; exec >/dev/null 2>&1; echo $$ > ${pidFile}; ` +
          `for _ in $(seq 1 200); do sleep 1; done' & sleep 30`,
      );
      const provider = new MockProvider([
        { content: [text("done")], stopReason: "end_turn" },
      ]);

      const result = await runTrial(task, provider, defaultConfig(), undefined, {
        trialTimeoutMs: 10_000,
        verifyTimeoutMs: 800,
      });
      expect(result.verifyOutput).toContain("Verifier timed out");

      const survivor = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(survivor)).toBe(true);

      const alive = () => {
        try {
          process.kill(survivor, 0);
          return true;
        } catch {
          return false;
        }
      };
      // SIGKILL is asynchronous; give the kernel a moment to reap it.
      for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(25);
      const escaped = alive();
      if (escaped) {
        try {
          process.kill(survivor, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      expect(escaped).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test("verifier output is capped while its pipes are fully drained", async () => {
    const root = tempDir();
    try {
      const task = makeTask(
        root,
        `bun -e 'process.stdout.write("x".repeat(10000)); process.exit(1)'`,
      );
      const provider = new MockProvider([
        { content: [text("done")], stopReason: "end_turn" },
      ]);

      const result = await runTrial(task, provider, defaultConfig(), undefined, {
        trialTimeoutMs: 1_000,
        verifyTimeoutMs: 500,
        verifyOutputBytes: 128,
      });

      expect(result.passed).toBe(false);
      expect(result.verifyOutput.length).toBeLessThan(500);
      expect(result.verifyOutput).toContain("truncated");
    } finally {
      cleanup(root);
    }
  });

  test("agent tools cannot use absolute paths, traversal, or shell to escape", async () => {
    const root = tempDir();
    try {
      const secret = "BENCH_SECRET_MUST_NOT_LEAK";
      writeFileSync(join(root, "secret.txt"), secret);
      const task = makeTask(root, "true");
      symlinkSync(join(root, "secret.txt"), join(task.repoDir, "secret-link"));
      const provider = new MockProvider([
        {
          content: [
            toolUse("absolute", "read_file", { path: join(root, "secret.txt") }),
            toolUse("traversal", "read_file", {
              path: `../${basename(root)}/secret.txt`,
            }),
            toolUse("symlink", "read_file", { path: "secret-link" }),
            toolUse("glob-traversal", "glob", {
              pattern: `../${basename(root)}/**/*`,
            }),
            toolUse("shell", "bash", { command: `cat ${join(root, "secret.txt")}` }),
          ],
          stopReason: "tool_use",
        },
        { content: [text("blocked")], stopReason: "end_turn" },
      ]);
      const observed: string[] = [];

      const result = await runTrial(
        task,
        provider,
        defaultConfig(),
        (event) => {
          if (event.type === "tool_end") observed.push(event.result.output);
          if (event.type === "tool_denied") observed.push(event.reason);
        },
        { trialTimeoutMs: 1_000, verifyTimeoutMs: 500 },
      );

      expect(result.passed).toBe(true);
      expect(result.denied).toBe(5);
      expect(observed.join("\n")).not.toContain(secret);
      expect(observed.join("\n")).toContain("benchmark workspace boundary");
    } finally {
      cleanup(root);
    }
  });

  test("weakening the visible test cannot earn a passing score", async () => {
    const task = loadTask(join(TASKS_DIR, "fix-failing-test"));
    const provider = new MockProvider([
      {
        content: [
          toolUse("fix", "edit_file", {
            path: "src/math.ts",
            old_str: "  return a - b;",
            new_str: "  return a + b;",
          }),
        ],
        stopReason: "tool_use",
      },
      {
        content: [
          toolUse("weaken", "write_file", {
            path: "test/math.test.ts",
            content: "",
            overwrite: true,
          }),
        ],
        stopReason: "tool_use",
      },
      { content: [text("done")], stopReason: "end_turn" },
    ]);

    const result = await runTrial(task, provider, defaultConfig());

    expect(result.passed).toBe(false);
    expect(result.verifyOutput).toContain("original test contract");
  }, 20_000);
});

function makeTask(root: string, verify: string): BenchTask {
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "README.md"), "fixture\n");
  return {
    name: "adversarial",
    root,
    repoDir,
    hiddenDir: join(root, "hidden"),
    spec: { prompt: "Complete the requested fixture task safely.", verify },
  };
}

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
