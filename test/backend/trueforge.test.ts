import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  test("normalizes a recorded TrueForge stream without losing refusal text", () => {
    const fixture = readFileSync(
      join(import.meta.dir, "..", "fixtures", "trueforge", "turn-stream.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; data: TrueForgeApi.TurnStreamingEvent });
    const backend = new TrueForgeBackend(dir, config(), {} as TrueForge);
    const events = fixture.flatMap(({ data }) => backend.mapEvent(data));

    expect(events).toContainEqual({
      type: "infrastructure",
      component: "sandbox",
      status: "ready",
      detail: "daytona-fixture",
    });
    expect(events).toContainEqual({
      type: "thread_start",
      id: "thread-fixture",
      title: "inspect fixture",
      agent: "explorer",
      depth: 1,
    });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual([
      "child result",
      "root answer",
      "cannot perform that action",
    ]);
  });

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
    expect(
      backend.mapEvent({
        type: "thread.created",
        id: "e3",
        createdAt: new Date().toISOString(),
        threadId: "child-2",
        title: "inspect nested fixture",
        agentInfo: { type: "dynamic", name: "nested-explorer", input: "inspect nested" },
        parent: { threadId: "child-1", toolCallId: "call-2" },
      }),
    ).toEqual([
      {
        type: "thread_start",
        id: "child-2",
        title: "inspect nested fixture",
        agent: "nested-explorer",
        depth: 2,
      },
    ]);
    expect(
      backend.mapEvent({
        type: "model.message.delta",
        id: "e4",
        threadId: "child-2",
        content: "nested result",
      }),
    ).toEqual([{ type: "text_delta", text: "nested result", depth: 2 }]);
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
        extraSystem: ["Follow the project memory for this turn."],
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
    const firstContent = first?.type === "user.message" && Array.isArray(first.content) ? first.content : [];
    expect(firstContent[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<rocky_turn_instructions>\nFollow the project memory for this turn.\n</rocky_turn_instructions>"),
    });
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

  test("cancels the TrueForge session and clears the resume cursor when aborted", async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cancelledSession: string | undefined;
    const client = {
      sessions: {
        create: async () => ({ data: { id: "session-cancel" } }),
        createTurnStream: async (
          _session: string,
          _request: unknown,
          options: { abortSignal: AbortSignal },
        ) => {
          async function* pending(): AsyncGenerator<TrueForgeApi.TurnStreamingEvent> {
            yield {
              type: "turn.created",
              id: "cancel-created",
              createdAt: new Date().toISOString(),
              threadId: null,
              turnId: "turn-cancel",
              previousTurnId: null,
              state: { status: "running" },
            };
            markStarted?.();
            await new Promise<void>((_resolve, reject) => {
              const abort = (): void => reject(new Error("stream aborted"));
              if (options.abortSignal.aborted) abort();
              else options.abortSignal.addEventListener("abort", abort, { once: true });
            });
          }
          return pending();
        },
        cancel: async (sessionId: string) => {
          cancelledSession = sessionId;
          return {};
        },
      },
    };
    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const collecting = collect(backend.turn("cancel me", { signal: controller.signal }));

    await started;
    controller.abort();
    const events = await collecting;

    expect(cancelledSession).toBe("session-cancel");
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "aborted" });
    expect(backend.status().activeTurnId).toBeUndefined();
    expect(
      JSON.parse(readFileSync(join(dir, ".rocky", "trueforge", "session.json"), "utf8")) as {
        activeTurnId?: string;
        lastSequenceNumber: number;
      },
    ).toMatchObject({ lastSequenceNumber: 0 });
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
        getTurn: async () => ({
          data: {
            id: "turn-persisted",
            sessionId: "session-persisted",
            previousTurnId: null,
            createdAt: new Date().toISOString(),
            state: { status: "running" as const },
          },
        }),
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

  test("replays a turn that completed while Rocky was offline before starting the next prompt", async () => {
    const stateDir = join(dir, ".rocky", "trueforge");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "session-completed",
        activeTurnId: "turn-completed",
        lastSequenceNumber: 3,
        snapshotAttached: true,
      }),
    );

    let subscribed = false;
    const requests: TrueForgeApi.TurnInputItem[][] = [];
    const completedMessage: TrueForgeApi.ModelMessageEvent = {
      type: "model.message",
      id: "completed-message",
      createdAt: new Date().toISOString(),
      threadId: "main",
      content: "completed while offline",
    };
    const completed = done("completed-done");
    const client = {
      sessions: {
        getTurn: async () => ({
          data: {
            id: "turn-completed",
            sessionId: "session-completed",
            previousTurnId: null,
            createdAt: new Date().toISOString(),
            state: completed.state,
          },
        }),
        listTurnEvents: async () => ({
          async *[Symbol.asyncIterator](): AsyncGenerator<TrueForgeApi.SessionEvent> {
            yield completedMessage;
            yield completed;
          },
        }),
        subscribeToTurn: async () => {
          subscribed = true;
          throw new Error("completed turn stream has expired");
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
              previousTurnId: "turn-completed",
              state: { status: "running" },
            };
            yield { type: "model.message.delta", id: "current-delta", threadId: "main", content: "current" };
            yield done("current-done");
          }
          return current();
        },
        cancel: async () => ({}),
      },
    };

    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const events = await collect(backend.turn("next", { signal: new AbortController().signal }));

    expect(subscribed).toBe(false);
    expect(requests[0]?.[0]).toEqual({ type: "user.message", content: "next" });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual([
      "completed while offline",
      "current",
    ]);
  });

  test("replays every page of persisted session events in chronological order", async () => {
    const stateDir = join(dir, ".rocky", "trueforge");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "session.json"),
      JSON.stringify({
        sessionId: "session-history",
        lastSequenceNumber: 0,
        snapshotAttached: true,
      }),
    );

    const older: TrueForgeApi.SessionEventItem = {
      turnId: "turn-older",
      event: {
        type: "model.message",
        id: "message-older",
        createdAt: new Date().toISOString(),
        threadId: "main",
        content: "older",
      },
    };
    const newer: TrueForgeApi.SessionEventItem = {
      turnId: "turn-newer",
      event: {
        type: "model.message",
        id: "message-newer",
        createdAt: new Date().toISOString(),
        threadId: "main",
        content: "newer",
      },
    };
    const newerCreated: TrueForgeApi.SessionEventItem = {
      turnId: "turn-newer",
      event: {
        type: "turn.created",
        id: "newer-created",
        createdAt: new Date().toISOString(),
        threadId: null,
        turnId: "turn-newer",
        previousTurnId: "turn-older",
        state: { status: "running" },
      },
    };
    const newerDone: TrueForgeApi.SessionEventItem = {
      turnId: "turn-newer",
      event: done("newer-done"),
    };
    const client = {
      sessions: {
        listEvents: async () => ({
          data: [newerDone, newer, newerCreated],
          async *[Symbol.asyncIterator](): AsyncGenerator<TrueForgeApi.SessionEventItem> {
            yield newerDone;
            yield newer;
            yield newerCreated;
            yield older;
          },
        }),
      },
    };

    const backend = new TrueForgeBackend(dir, config(), client as unknown as TrueForge);
    const events = await collect(backend.replay());

    expect(events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual([
      "older",
      "newer",
    ]);
    expect(backend.status().connection).toBe("ready");
    expect(backend.status().activeTurnId).toBeUndefined();
    expect(backend.status().phase).toBe("idle");
  });
});
