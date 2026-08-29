import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
import { checkPreservedContract } from "../bench/tasks/fix-failing-test/hidden/preserve_test.ts";
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
      // The descendant releases the pipes it inherited and ignores SIGTERM, so
      // the leader's exit closes stdout/stderr and resolves every promise the
      // verifier awaits while this process is still running. Only a sweep of
      // the whole group reaps it.
      //
      // The redirection lives in a script rather than the verify command so the
      // command the harness executes stays free of shell metacharacters.
      const task = makeTask(root, "bash survivor.sh & sleep 30");
      writeFileSync(
        join(task.repoDir, "survivor.sh"),
        ['trap "" TERM', "exec >/dev/null 2>&1", `echo $$ > ${pidFile}`, "sleep 200", ""].join(
          "\n",
        ),
      );
      const provider = new MockProvider([
        { content: [text("done")], stopReason: "end_turn" },
      ]);

      const result = await runTrial(task, provider, defaultConfig(), undefined, {
        trialTimeoutMs: 15_000,
        verifyTimeoutMs: 800,
      });
      expect(result.verifyOutput).toContain("Verifier timed out");

      // The descendant records its pid asynchronously, so the file may not
      // exist the instant the trial returns. Waiting here keeps a slow start
      // from being reported as a cleanup failure.
      let recorded = "";
      for (let i = 0; i < 100 && !recorded; i++) {
        try {
          recorded = readFileSync(pidFile, "utf8").trim();
        } catch {
          await Bun.sleep(25);
        }
      }
      expect(recorded).not.toBe("");
      const survivor = Number(recorded);
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
    expect(result.verifyOutput).toContain(
      "no longer fails when add(2, 3) is broken",
    );
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

describe("visible-test contract", () => {
  const TASK_DIR = join(TASKS_DIR, "fix-failing-test");
  const ORIGINAL = readFileSync(
    join(TASK_DIR, "repo", "test", "math.test.ts"),
    "utf8",
  );
  const BODY = ORIGINAL.slice(ORIGINAL.indexOf("test("));
  const HEADER =
    `import { describe, expect, test } from "bun:test";\n` +
    `import { add } from "../src/math.ts";\n`;
  // What a solved task looks like: the agent has already fixed the bug.
  const FIXED = "export const add = (a: number, b: number): number => a + b;\n";

  /** A solved copy of the task repo with `candidate` as the visible test file. */
  function solvedRepo(candidate: string | null): string {
    const root = tempDir();
    cpSync(join(TASK_DIR, "repo"), root, { recursive: true });
    writeFileSync(join(root, "src", "math.ts"), FIXED);

    const testFile = join(root, "test", "math.test.ts");
    if (candidate === null) rmSync(testFile);
    else writeFileSync(testFile, candidate);
    return root;
  }

  async function check(candidate: string | null): Promise<string | null> {
    const root = solvedRepo(candidate);
    try {
      return await checkPreservedContract(root);
    } finally {
      cleanup(root);
    }
  }

  // The task forbids weakening or deleting tests. It does not forbid improving
  // them — an earlier byte-for-byte check scored a strengthened suite as a
  // failure, which is a stricter contract than the prompt states.
  test("an agent that strengthens the suite is not scored as a failure", async () => {
    const allowed: Array<[string, string]> = [
      ["untouched", ORIGINAL],
      [
        "an extra test appended",
        `${ORIGINAL}\ntest("adds negative numbers", () => {\n  expect(add(-4, 9)).toBe(5);\n});\n`,
      ],
      [
        "an explanatory comment added",
        ORIGINAL.replace(
          'test("adds two numbers"',
          '// regression: add() used to subtract\ntest("adds two numbers"',
        ),
      ],
      [
        "reformatted, renamed, and switched to toEqual",
        `${HEADER}test("adds them", () => { expect(add(2,3)).toEqual(5) })\n`,
      ],
      [
        // Qodo, PR #6: a *closed* skipped suite before the untouched original
        // does not disable it. Source order is not ancestry.
        "an unrelated skipped suite added before the original",
        `${HEADER}describe.skip("old behaviour", () => {});\n${BODY}`,
      ],
      [
        "the original wrapped in a plain describe",
        `${HEADER}describe("math", () => {\n${BODY}});\n`,
      ],
    ];

    const results = await Promise.all(allowed.map(([, src]) => check(src)));
    for (const [i, [name]] of allowed.entries()) {
      expect(results[i], name).toBeNull();
    }
  }, 60_000);

  test("deleting, weakening, or disabling the shipped assertion fails", async () => {
    const rejected: Array<[string, string | null, string]> = [
      ["deleted outright", null, "was deleted"],
      [
        "assertion rewritten to match the bug",
        `${HEADER}test("adds two numbers", () => { expect(add(2, 3)).toBe(-1); });\n`,
        "does not pass against a correct add",
      ],
      [
        "assertion commented out",
        `${HEADER}// test("adds", () => { expect(add(2, 3)).toBe(5); });\n` +
          `test("trivial", () => { expect(1).toBe(1); });\n`,
        "no longer fails when add(2, 3) is broken",
      ],
      [
        "shipped test skipped",
        `${HEADER}test.skip("adds two numbers", () => { expect(add(2, 3)).toBe(5); });\n`,
        "no longer fails when add(2, 3) is broken",
      ],
      [
        "shipped test buried in a skipped suite",
        `${HEADER}describe.skip("math", () => {\n${BODY}});\n`,
        "no longer fails when add(2, 3) is broken",
      ],
      [
        // Qodo, PR #6: assertion-shaped text in a regex literal asserts nothing.
        "assertion present only as a regex literal",
        `${HEADER}test("unrelated", () => { expect(1).toBe(1); });\n` +
          `const marker = /expect(add(2,3)).toBe(5)/;\n`,
        "no longer fails when add(2, 3) is broken",
      ],
      [
        // Qodo, PR #6: an assertion behind dead code never runs. No amount of
        // reading the file can tell; running it can.
        "assertion left unreachable behind dead code",
        `${HEADER}test("adds", () => { if (false) expect(add(2, 3)).toBe(5); });\n`,
        "no longer fails when add(2, 3) is broken",
      ],
      [
        // Qodo, PR #6: `.only` makes the suite's verdict depend on whether the
        // runner thinks it is on CI, so the assertion is not reliably enforced
        // even when the file looks intact.
        "a focused test elsewhere, which excludes the shipped one",
        `${HEADER}${BODY}test.only("always passes", () => { expect(1).toBe(1); });\n`,
        "depends on the environment",
      ],
      [
        "the original wrapped in describe.only",
        `${HEADER}describe.only("math", () => {\n${BODY}});\n`,
        "depends on the environment",
      ],
      [
        // Qodo, PR #6: a suite that recognises the implementation instead of
        // asserting on it would pass the correct run and fail the mutant while
        // pinning nothing. The per-run nonce leaves it nothing to recognise.
        "a suite that inspects the implementation source instead of asserting",
        `import { expect, test } from "bun:test";\n` +
          `import { readFileSync } from "node:fs";\n` +
          `test("implementation is byte-for-byte the known-good one", () => {\n` +
          `  expect(readFileSync("src/math.ts", "utf8")).toBe(\n` +
          `    "export const add = (a: number, b: number): number => {\\n  return a + b;\\n};\\n",\n` +
          `  );\n});\n`,
        "does not pass against a correct add",
      ],
      [
        // Qodo, PR #6: a suite that passes once and fails afterwards would look
        // like the mutant being caught. Every run gets a fresh copy, so the
        // marker it leaves is never there to find.
        "a suite that tries to pass once and fail on the next run",
        `import { expect, test } from "bun:test";\n` +
          `import { existsSync, writeFileSync } from "node:fs";\n` +
          `test("fails only after it has run once", () => {\n` +
          `  const seen = existsSync("ran-before");\n` +
          `  writeFileSync("ran-before", "1");\n` +
          `  expect(seen).toBe(false);\n});\n`,
        "no longer fails when add(2, 3) is broken",
      ],
    ];

    const results = await Promise.all(rejected.map(([, src]) => check(src)));
    for (const [i, [name, , expected]] of rejected.entries()) {
      expect(results[i], `${name} should have been rejected`).toContain(
        expected,
      );
    }
  }, 90_000);

  // Qodo, PR #6: a broken test file is the runner's problem, not evidence about
  // what the agent did to the assertion.
  test("a test file that cannot load is reported as such, not blamed on the agent", async () => {
    const reason = await check(
      `import { expect, test } from "bun:test";\nthrow new Error("boom at module scope");\n`,
    );
    expect(reason).toContain("could not be run");
    expect(reason).not.toContain("rewritten");
  }, 30_000);

  // Qodo, PR #6 (security): cpSync recreates symlinks and writeFileSync follows
  // them, so a repo whose src/math.ts is a link could steer the probe's write
  // outside its own copy.
  test("a symlinked implementation cannot redirect the probe's write", async () => {
    const outside = tempDir();
    const root = solvedRepo(ORIGINAL);
    try {
      const bystander = join(outside, "bystander.txt");
      writeFileSync(bystander, "untouched\n");

      const impl = join(root, "src", "math.ts");
      rmSync(impl);
      symlinkSync(bystander, impl);

      await checkPreservedContract(root);

      expect(readFileSync(bystander, "utf8")).toBe("untouched\n");
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  }, 30_000);

  // Qodo, PR #6: the verifier runs with this task's hidden/ overlay copied into
  // the repo root. If the probe carried it into the tree where the agent's own
  // test code runs, that code could read the judge and answer to it.
  test("the hidden overlay is not visible to the code being judged", async () => {
    const candidate =
      `import { expect, test } from "bun:test";\n` +
      `import { existsSync } from "node:fs";\n` +
      `import { add } from "../src/math.ts";\n` +
      `test("cannot see the judge", () => {\n` +
      `  expect(existsSync("preserve_test.ts")).toBe(false);\n` +
      `  expect(existsSync("hidden_check.ts")).toBe(false);\n` +
      `  expect(add(2, 3)).toBe(5);\n});\n`;

    const root = solvedRepo(candidate);
    try {
      // The overlay is present in the repo, exactly as the verifier sees it.
      cpSync(join(TASK_DIR, "hidden"), root, { recursive: true });
      expect(existsSync(join(root, "preserve_test.ts"))).toBe(true);

      // …and absent from every copy the candidate test actually runs in, so the
      // assertions above hold and the contract still reads as preserved.
      expect(await checkPreservedContract(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  }, 30_000);

  // Qodo, PR #6: a candidate controls both output streams, and three probes run
  // at once — reading them to completion would let a noisy test exhaust the
  // verifier rather than fail.
  test("a test that floods its output is capped, not allowed to exhaust the check", async () => {
    const reason = await check(
      `import { expect, test } from "bun:test";\n` +
        `import { add } from "../src/math.ts";\n` +
        `test("noisy", () => {\n` +
        `  for (let i = 0; i < 4000; i++) console.log("x".repeat(200));\n` +
        `  expect(add(2, 3)).toBe(5);\n});\n`,
    );
    expect(reason).toContain("more output than the check will read");
  }, 30_000);

  // Qodo, PR #6: flooding on the *mutant* run only. The killed run looks exactly
  // like one that caught the mutant, so checking the control alone let a suite
  // that asserts nothing be read as preserving the contract.
  test("a test that floods only when it spots the mutant is not credited with catching it", async () => {
    const reason = await check(
      `import { expect, test } from "bun:test";\n` +
        `import { add } from "../src/math.ts";\n` +
        `test("asserts nothing, shouts when mutated", () => {\n` +
        `  if (add(2, 3) !== 5) {\n` +
        `    for (let i = 0; i < 4000; i++) console.log("x".repeat(200));\n` +
        `  }\n` +
        `  expect(1).toBe(1);\n});\n`,
    );
    expect(reason).toContain("more output than the check will read");
  }, 30_000);

  // The mutation runs in throwaway copies; the repo the verifier goes on to
  // test must come back exactly as the agent left it.
  test("the check does not disturb the repository it inspects", async () => {
    const root = solvedRepo(ORIGINAL);
    try {
      expect(await checkPreservedContract(root)).toBeNull();
      expect(readFileSync(join(root, "src", "math.ts"), "utf8")).toBe(FIXED);
      expect(readFileSync(join(root, "test", "math.test.ts"), "utf8")).toBe(
        ORIGINAL,
      );
    } finally {
      cleanup(root);
    }
  }, 30_000);

  // The logic above is exercised in-process; this proves the overlay is still
  // wired up as a script the verifier can run, with the exit codes it reads.
  test("the overlay runs as a script and reports through its exit code", async () => {
    const run = async (candidate: string | null) => {
      const root = solvedRepo(candidate);
      try {
        cpSync(join(TASK_DIR, "hidden"), root, { recursive: true });
        const proc = Bun.spawn([process.execPath, "run", "preserve_test.ts"], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, output: stdout + stderr };
      } finally {
        cleanup(root);
      }
    };

    const preserved = await run(ORIGINAL);
    expect(preserved.code).toBe(0);
    expect(preserved.output).toContain("PASS");

    const gone = await run(null);
    expect(gone.code).not.toBe(0);
    expect(gone.output).toContain("FAIL: original test contract was deleted");
  }, 30_000);
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
