import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeBackend } from "../../src/backend/trueforge.ts";
import { defaultConfig, type Config } from "../../src/config/schema.ts";
import type { LoopEvent } from "../../src/core/loop.ts";
import { cleanup, tempDir } from "../helpers.ts";

let dir: string;
beforeEach(() => {
  dir = tempDir();
  writeFileSync(join(dir, "index.ts"), "export const value = 1;\n");
});
afterEach(() => cleanup(dir));

function config(): Config {
  return defaultConfig();
}

const done = (id: string, metrics?: TrueForgeApi.TurnMetrics): TrueForgeApi.TurnDoneEvent => ({
  type: "turn.done",
  id,
  createdAt: new Date().toISOString(),
  threadId: null,
  state: {
    status: "done",
    completedAt: new Date().toISOString(),
    output: null,
    requiredActions: [],
    ...(metrics ? { metrics } : {}),
  },
});

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("TrueForge backend", () => {
  test("maps streaming, subagent, sandbox, and MCP events into UI events", () => {
    const backend = new TrueForgeBackend(dir, config(), {} as TrueForge);
    expect(
      backend.mapEvent({
        type: "sandbox.created",
        id: "e1",
        createdAt: new Date().toISOString(),
        threadId: null,
        sandboxId: "daytona-1",
      }),
    ).toEqual([{ type: "infrastructure", component: "sandbox", status: "ready", detail: "daytona-1" }]);
    expect(
      backend.mapEvent({
        type: "thread.created",
        id: "e2",
        createdAt: new Date().toISOString(),
        threadId: "child-1",
        title: "inspect tests",
        agentInfo: { type: "dynamic", name: "explorer", input: "inspect" },
        parent: { threadId: "main", toolCallId: "call-1" },
      }),
    ).toEqual([{ type: "thread_start", id: "child-1", title: "inspect tests", agent: "explorer", depth: 1 }]);
  });

  test("attaches one sanitized snapshot, pauses for approval, and resumes with the decision", async () => {
    const requests: TrueForgeApi.TurnInputItem[][] = [];
    let approvalPreview: string | undefined;
    let call = 0;
    const approval: TrueForgeApi.ToolApprovalRequiredEvent = {
      type: "tool.approval_required",
      id: "approval-1",
      createdAt: new Date().toISOString(),
      threadId: "main",
      toolCalls: [{ id: "tool-1", sourceEventId: "message-1" }],
    };
    const client = {
      settings: { mcpServers: { createOrUpdate: async () => ({}) } },
      sessions: {
        create: async () => ({ data: { id: "session-1" } }),
        createTurnStream: async (_sessionId: string, request: { input?: TrueForgeApi.TurnInputItem[] }) => {
          requests.push(request.input ?? []);
          call++;
          async function* stream(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield {
              type: "turn.created",
              id: `created-${call}`,
              createdAt: new Date().toISOString(),
              threadId: null,
              turnId: `turn-${call}`,
              previousTurnId: null,
              state: { status: "running" },
            };
            if (call === 1) {
              yield {
                type: "model.message",
                id: "message-1",
                createdAt: new Date().toISOString(),
                threadId: "main",
                toolCalls: [
                  {
                    id: "tool-1",
                    type: "function",
                    function: {
                      name: "workspace_apply_patch",
                      arguments: JSON.stringify({
                        snapshotId: "abc",
                        patch: "--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
                      }),
                    },
                    toolInfo: { type: "mcp", name: "workspace_apply_patch", serverId: "s", serverName: "rocky" },
                  },
                ],
              };
              yield approval;
              yield {
                ...done("done-1"),
                state: {
                  status: "done",
                  completedAt: new Date().toISOString(),
                  output: null,
                  requiredActions: [approval],
                },
              };
            } else {
              yield {
                type: "model.message.delta",
                id: "delta-2",
                threadId: "main",
                content: "finished",
              };
              yield done("done-2", {
                totalInputTokens: 20,
                totalOutputTokens: 5,
                totalCostInUsd: 0.004,
              });
            }
          }
          return stream();
        },
        cancel: async () => ({}),
      },
    };
    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const events = await collect(
      backend.turn("fix it", {
        signal: new AbortController().signal,
        approveAction: async (request) => {
          approvalPreview = request.preview;
          return { allow: true };
        },
      }),
    );

    expect(requests).toHaveLength(2);
    const first = requests[0]?.[0];
    expect(first?.type).toBe("user.message");
    expect(Array.isArray(first && "content" in first ? first.content : undefined)).toBe(true);
    expect(requests[1]?.[0]).toMatchObject({
      type: "user.tool_approval",
      toolCallId: "tool-1",
      approval: { status: "allow" },
    });
    expect(events.some((event) => event.type === "phase" && event.phase === "awaiting_approval")).toBe(true);
    expect(approvalPreview).toContain(`destination: ${dir}`);
    expect(approvalPreview).toContain("files: 1 · +1 -1");
    expect(approvalPreview).toContain("index.ts");
    expect(events.some((event) => event.type === "text_delta" && event.text === "finished")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "turn_end",
      stopReason: "end_turn",
      costUsd: 0.004,
      usage: { inputTokens: 20, outputTokens: 5 },
    });
  });

  test("reconnects with the persisted sequence cursor", async () => {
    let cursor: number | null | undefined;
    const client = {
      sessions: {
        create: async () => ({ data: { id: "session-2" } }),
        createTurnStream: async () => {
          async function* broken(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield {
              type: "turn.created",
              id: "created",
              createdAt: new Date().toISOString(),
              threadId: null,
              turnId: "turn-reconnect",
              previousTurnId: null,
              state: { status: "running" },
            };
            throw new Error("connection reset");
          }
          return broken();
        },
        subscribeToTurn: async (_session: string, _turn: string, request: { afterSequenceNumber?: number | null }) => {
          cursor = request.afterSequenceNumber;
          async function* resumed(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield { type: "model.message.delta", id: "delta", threadId: "main", content: "back" };
            yield done("done");
          }
          return resumed();
        },
        cancel: async () => ({}),
      },
    };
    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const events = await collect(backend.turn("continue", { signal: new AbortController().signal }));
    expect(cursor).toBe(1);
    expect(events.some((event) => event.type === "infrastructure" && event.status === "connecting")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.text === "back")).toBe(true);
  });

  test("recovers an active persisted turn before starting the next prompt", async () => {
    const stateDir = join(dir, ".rocky", "trueforge");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "session-persisted",
        activeTurnId: "turn-persisted",
        lastSequenceNumber: 3,
        snapshotAttached: true,
      }),
    );
    let resumeCursor: number | null | undefined;
    const requests: TrueForgeApi.TurnInputItem[][] = [];
    const client = {
      sessions: {
        subscribeToTurn: async (
          _session: string,
          _turn: string,
          request: { afterSequenceNumber?: number | null },
        ) => {
          resumeCursor = request.afterSequenceNumber;
          async function* recovered(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield {
              type: "model.message.delta",
              id: "old-delta",
              threadId: "main",
              content: "recovered",
            };
            yield done("old-done");
          }
          return recovered();
        },
        createTurnStream: async (
          _session: string,
          request: { input?: TrueForgeApi.TurnInputItem[] },
        ) => {
          requests.push(request.input ?? []);
          async function* current(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield {
              type: "turn.created",
              id: "current-created",
              createdAt: new Date().toISOString(),
              threadId: null,
              turnId: "turn-current",
              previousTurnId: "turn-persisted",
              state: { status: "running" },
            };
            yield {
              type: "model.message.delta",
              id: "current-delta",
              threadId: "main",
              content: "current",
            };
            yield done("current-done");
          }
          return current();
        },
        cancel: async () => ({}),
      },
    };
    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const events = await collect(backend.turn("next", { signal: new AbortController().signal }));
    expect(resumeCursor).toBe(3);
    expect(requests[0]?.[0]).toEqual({ type: "user.message", content: "next" });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual([
      "recovered",
      "current",
    ]);
    expect(events.some((event) => event.type === "infrastructure" && event.detail === "persisted turn recovered")).toBe(true);
  });
});
