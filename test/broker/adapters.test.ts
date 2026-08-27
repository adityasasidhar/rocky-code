import { describe, expect, test } from "bun:test";
import { parseWorkerStream } from "../../src/broker/adapters.ts";
import {
  RecoveryBudget,
  assertRecoveryAllowed,
  classifyFailure,
  recommendWorkers,
} from "../../src/broker/recovery.ts";
import type { WorkerHealth } from "../../src/broker/types.ts";

describe("worker event adapters", () => {
  test("normalizes Codex JSONL and falls back for malformed lines", () => {
    const events = parseWorkerStream(
      "codex",
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\nnot-json',
    );
    expect(events.map((event) => event.type)).toEqual(["completed", "message"]);
    expect(events[1]?.rawType).toBe("plain-text-fallback");
  });

  test("normalizes Claude and OpenCode tool/result events", () => {
    expect(parseWorkerStream("claude", '{"type":"result","is_error":false,"result":"ok"}')[0]?.type).toBe("completed");
    expect(parseWorkerStream("opencode", '{"type":"tool_use","name":"bash","text":"test"}')[0]).toMatchObject({
      type: "tool",
      tool: "bash",
    });
  });
});

describe("bounded recovery and recommendations", () => {
  test("classifies failures before retrying", () => {
    expect(classifyFailure("401 invalid API key")).toBe("authentication");
    expect(classifyFailure("deadline timed out")).toBe("timeout");
    expect(classifyFailure("tests failed in Daytona")).toBe("validation_failed");
  });

  test("never permits more than three attempts", () => {
    const budget = new RecoveryBudget(3);
    expect([budget.consume(), budget.consume(), budget.consume()]).toEqual([1, 2, 3]);
    expect(() => budget.consume()).toThrow(/limit/);
    expect(() => assertRecoveryAllowed("task-123", 3, 3)).toThrow(/task-123/);
    expect(() => assertRecoveryAllowed("task-123", 2, 3)).not.toThrow();
  });

  test("ranks healthy capability matches ahead of unavailable workers", () => {
    const base: WorkerHealth = {
      name: "codex",
      kind: "codex",
      enabled: true,
      image: "codex:1",
      version: "1",
      capabilities: ["typescript"],
      available: true,
      authenticated: true,
      recentSuccessRate: 1,
      costTier: 2,
      running: 0,
      concurrency: 1,
    };
    const ranked = recommendWorkers([base, { ...base, name: "claude", kind: "claude", available: false }], ["typescript"]);
    expect(ranked[0]?.name).toBe("codex");
  });

  test("uses configured cost and observed latency as ranking signals", () => {
    const base: WorkerHealth = {
      name: "slow",
      kind: "codex",
      enabled: true,
      image: "worker:1",
      version: "1",
      capabilities: ["typescript"],
      available: true,
      authenticated: true,
      recentSuccessRate: 1,
      averageLatencyMs: 300_000,
      costTier: 5,
      running: 0,
      concurrency: 1,
    };
    const ranked = recommendWorkers([
      base,
      { ...base, name: "fast", averageLatencyMs: 10_000, costTier: 1 },
    ]);
    expect(ranked[0]?.name).toBe("fast");
  });
});
