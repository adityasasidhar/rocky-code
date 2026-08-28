import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { Config } from "../config/schema.ts";
import type { LoopEvent } from "../core/loop.ts";
import { addUsage, emptyUsage, type StopReason, type Usage } from "../core/types.ts";
import { inspectPatch } from "../workspace/patch.ts";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "../workspace/snapshot.ts";
import type {
  AgentBackend,
  BackendApprovalRequest,
  BackendStatus,
  BackendTurnOptions,
} from "./types.ts";

interface PersistedState {
  sessionId?: string;
  activeTurnId?: string;
  lastSequenceNumber: number;
  snapshotId?: string;
  snapshotAttached: boolean;
}

interface StreamOutcome {
  terminal?: TrueForgeApi.TurnDoneEvent;
  approvals: TrueForgeApi.UserToolApprovalEvent[];
  externalActions: Array<
    TrueForgeApi.McpAuthRequiredEvent | TrueForgeApi.ToolResponseRequiredEvent
  >;
}

interface MetadataStream extends AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
  withMetadata(): AsyncIterable<{
    data: TrueForgeApi.TurnStreamingEvent;
    id?: string;
  }>;
}

const ROOT_INSTRUCTIONS = `You are Rocky, an orchestration-first terminal coding agent running inside TrueForge.

TrueForge owns the root loop, sessions, dynamic subagents, MCP, Daytona sandbox, compaction, and approvals. Use the rocky-worker-broker MCP tools when an enabled Codex, Claude Code, or OpenCode worker is a better fit. Workers only edit disposable snapshot copies and return candidate patches.

For code changes:
1. Inspect the attached workspace snapshot in the Daytona sandbox.
2. Query worker health and recommendations before delegating. Respect an explicit @codex, @claude, @opencode, or /worker selection. Create one stable taskId for the user task and pass the same taskId to every worker_start call, including retries and parallel candidates.
3. Limit recovery to three worker attempts. The broker enforces the configured per-task cap. Authentication/configuration failures need setup guidance; timeout/crash gets one reduced retry then another worker; invalid patches or failed tests get one evidence-backed repair attempt.
4. Apply every candidate to a fresh Daytona copy and run project checks independently. Separate worker claims from validation evidence.
5. Call workspace_apply_patch only for the selected, independently validated patch. This tool is approval-gated. Never claim the user's checkout changed before its tool response succeeds.
6. Generated task tools stay under .rocky-tools inside Daytona. Require manifest.json with name, purpose, inputSchema, argv command, and expectedOutputs; a restricted run entrypoint; and passing smoke tests. Never load generated code into the Rocky host or persist it across sessions.

Self-repair is allowed only after diagnostics locate the fault in Rocky itself and normal recovery failed. Validate with bun test and bunx tsc --noEmit, request approval, and report that restart is required.`;

function fqn(config: Config): string {
  if (config.trueforge.model) return config.trueforge.model;
  if (config.model.includes("/")) return config.model;
  const provider = config.provider.kind === "anthropic" ? "anthropic" : config.provider.kind === "openai" ? "openai" : config.provider.kind;
  return `${provider}/${config.model}`;
}

function textContent(content: TrueForgeApi.ModelMessageEventContent | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function usageFromMetrics(metrics: TrueForgeApi.TurnMetrics | undefined): Usage {
  if (!metrics) return emptyUsage();
  return {
    inputTokens: metrics.totalInputTokens ?? 0,
    outputTokens: metrics.totalOutputTokens ?? 0,
    cacheCreationInputTokens: metrics.totalCacheWriteTokens ?? 0,
    cacheReadInputTokens: metrics.totalCacheReadTokens ?? 0,
  };
}

function stopReason(status: string): StopReason {
  if (status === "cancelled") return "aborted";
  return status === "error" ? "refusal" : "end_turn";
}

function turnEndEvent(
  status: string,
  usage: Usage,
  costUsd?: number,
): Extract<LoopEvent, { type: "turn_end" }> {
  return {
    type: "turn_end",
    stopReason: stopReason(status),
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function sequenceNumber(id: string | undefined, fallback: number): number {
  if (!id || !/^\d+$/.test(id)) return fallback;
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeArgs(args: string): string {
  try {
    const value = JSON.parse(args) as unknown;
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return args.length > 120 ? `${args.slice(0, 117)}…` : args;
  }
}

function approvalPreview(root: string, name: string, args: string): string | undefined {
  if (name !== "workspace_apply_patch" && name !== "workspace_undo") return undefined;
  if (name === "workspace_undo") return `destination: ${root}\nrestore the requested Rocky checkpoint`;
  try {
    const parsed = JSON.parse(args) as { patch?: unknown };
    if (typeof parsed.patch !== "string") return `destination: ${root}`;
    const summary = inspectPatch(parsed.patch);
    return [
      `destination: ${root}`,
      `files: ${summary.files.length} · +${summary.additions} -${summary.deletions}`,
      ...summary.files.map((path) => `  ${path}`),
    ].join("\n");
  } catch (error) {
    return `destination: ${root}\n${error instanceof Error ? error.message : String(error)}`;
  }
}

export class TrueForgeBackend implements AgentBackend {
  readonly kind = "trueforge" as const;
  readonly displayName = "TrueForge";
  private readonly client: TrueForge;
  private readonly statePath: string;
  private state: PersistedState;
  private connection: BackendStatus["connection"] = "offline";
  private sandbox: BackendStatus["sandbox"] = "unknown";
  private phase: BackendStatus["phase"] = "idle";
  private snapshot: WorkspaceSnapshot | undefined;
  private readonly toolNames = new Map<string, { name: string; summary: string; preview?: string }>();
  private readonly threadDepths = new Map<string, number>();
  private brokerEndpoint: { url: string; token: string } | undefined;
  private brokerRegistered = false;

  constructor(
    private readonly root: string,
    private readonly config: Config,
    client?: TrueForge,
  ) {
    const token = process.env[config.trueforge.tokenEnv];
    this.client =
      client ??
      new TrueForge({
        baseUrl: config.trueforge.baseUrl,
        ...(token ? { token } : {}),
      });
    const dir = join(root, ".rocky", "trueforge");
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, "session.json");
    this.state = this.loadState();
  }

  private loadState(): PersistedState {
    if (!existsSync(this.statePath)) return { lastSequenceNumber: 0, snapshotAttached: false };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PersistedState>;
      return {
        ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
        ...(typeof parsed.activeTurnId === "string" ? { activeTurnId: parsed.activeTurnId } : {}),
        ...(typeof parsed.snapshotId === "string" ? { snapshotId: parsed.snapshotId } : {}),
        lastSequenceNumber: parsed.lastSequenceNumber ?? 0,
        snapshotAttached: parsed.snapshotAttached ?? false,
      };
    } catch {
      return { lastSequenceNumber: 0, snapshotAttached: false };
    }
  }

  private saveState(): void {
    writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
  }

  private clearActiveTurn(): void {
    this.state.activeTurnId = undefined;
    this.state.lastSequenceNumber = 0;
    this.saveState();
  }

  private async ensureSession(): Promise<string> {
    await this.ensureBrokerRegistered();
    if (this.state.sessionId) return this.state.sessionId;
    this.connection = "connecting";
    const agent = this.config.trueforge.agent
      ? { name: this.config.trueforge.agent }
      : {
          spec: {
            model: { name: fqn(this.config) },
            instructions: ROOT_INSTRUCTIONS,
            config: {
              iterationLimit: 100,
              sandbox: { enabled: this.config.trueforge.sandbox, fileDownloads: true },
              dynamicSubAgents: { enabled: this.config.trueforge.dynamicSubagents },
              contextManagement: {
                compaction: { enabled: true },
                largeToolResponse: { enabled: true },
              },
            },
            mcpServers: [
              {
                name: this.config.trueforge.brokerMcpName,
                enableTools: ["@all" as const],
                requireApprovalForTools: ["workspace_apply_patch", "workspace_undo", "worker_cancel"],
                preloadTools: ["worker_list", "worker_recommend"],
              },
            ],
          },
        };
    const created = await this.client.sessions.create({ agent });
    this.state.sessionId = created.data.id;
    this.state.lastSequenceNumber = 0;
    this.saveState();
    this.connection = "ready";
    return created.data.id;
  }

  configureBroker(url: string, token: string): void {
    this.brokerEndpoint = { url, token };
  }

  private async ensureBrokerRegistered(): Promise<void> {
    if (this.brokerRegistered || !this.brokerEndpoint) return;
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        name: this.config.trueforge.brokerMcpName,
        description: "Rocky's isolated Codex, Claude Code, and OpenCode worker broker plus approval-gated workspace patch tools.",
        type: "remote",
        url: this.brokerEndpoint.url,
        auth: {
          type: "header",
          headers: { Authorization: `Bearer ${this.brokerEndpoint.token}` },
        },
      },
    });
    this.brokerRegistered = true;
  }

  private workspaceSnapshot(): WorkspaceSnapshot {
    if (!this.snapshot) {
      this.snapshot = createWorkspaceSnapshot(this.root, {
        maxBytes: this.config.broker.maxSnapshotBytes,
        secretPatterns: this.config.broker.secretPatterns,
      });
      this.state.snapshotId = this.snapshot.id;
      this.saveState();
    }
    return this.snapshot;
  }

  private userInput(prompt: string, extraSystem: string[] = []): TrueForgeApi.UserMessage {
    const contextualPrompt =
      extraSystem.length === 0
        ? prompt
        : `<rocky_turn_instructions>\n${extraSystem.join("\n\n")}\n</rocky_turn_instructions>\n\n${prompt}`;
    if (this.state.snapshotAttached) return { type: "user.message", content: contextualPrompt };
    const snapshot = this.workspaceSnapshot();
    return {
      type: "user.message",
      content: [
        {
          type: "text",
          text: `${contextualPrompt}\n\n<rocky_workspace_snapshot id="${snapshot.id}">The attached sanitized archive is the immutable delegation baseline. Validate candidate patches against it before requesting workspace application.</rocky_workspace_snapshot>`,
        },
        {
          type: "file",
          name: `rocky-workspace-${snapshot.id}.tar.gz`,
          data: `data:application/gzip;base64,${Buffer.from(snapshot.archive).toString("base64")}`,
        },
      ],
    };
  }

  mapEvent(event: TrueForgeApi.TurnStreamingEvent, replay = false): LoopEvent[] {
    const depth =
      "threadId" in event && event.threadId && event.threadId !== "main"
        ? (this.threadDepths.get(event.threadId) ?? 1)
        : undefined;
    switch (event.type) {
      case "turn.created":
        if (replay) return [];
        this.state.activeTurnId = event.turnId;
        this.saveState();
        return [{ type: "infrastructure", component: "trueforge", status: "running", detail: `turn ${event.turnId.slice(0, 8)}` }];
      case "sandbox.created":
        if (!replay) this.sandbox = "ready";
        return [{ type: "infrastructure", component: "sandbox", status: "ready", detail: event.sandboxId }];
      case "mcp.initialize":
        return [
          {
            type: "infrastructure",
            component: "mcp",
            status: "ready",
            detail: event.mcpServers.map((server) => server.name).join(", ") || "initialized",
            ...(depth ? { depth } : {}),
          },
        ];
      case "thread.created": {
        if (!replay) this.phase = "delegated";
        const parentDepth =
          event.parent.threadId === "main"
            ? 0
            : (this.threadDepths.get(event.parent.threadId) ?? 1);
        const threadDepth = parentDepth + 1;
        this.threadDepths.set(event.threadId, threadDepth);
        return [{ type: "thread_start", id: event.threadId, title: event.title, agent: event.agentInfo.name, depth: threadDepth }];
      }
      case "thread.done": {
        const threadDepth = this.threadDepths.get(event.threadId) ?? depth ?? 1;
        this.threadDepths.delete(event.threadId);
        return [
          {
            type: "thread_end",
            id: event.threadId,
            ok: event.state.status === "done",
            ...(event.state.status === "error" ? { detail: event.state.error } : {}),
            depth: threadDepth,
          },
        ];
      }
      case "model.message.delta": {
        const events: LoopEvent[] = [];
        if (event.reasoningContent) events.push({ type: "thinking_delta", text: event.reasoningContent, ...(depth ? { depth } : {}) });
        if (event.content) events.push({ type: "text_delta", text: event.content, ...(depth ? { depth } : {}) });
        if (event.refusal) events.push({ type: "text_delta", text: event.refusal, ...(depth ? { depth } : {}) });
        return events;
      }
      case "model.message": {
        const events: LoopEvent[] = [];
        for (const call of event.toolCalls ?? []) {
          const name = call.function.name;
          const summary = summarizeArgs(call.function.arguments);
          const preview = approvalPreview(this.root, name, call.function.arguments);
          this.toolNames.set(call.id, { name, summary, ...(preview ? { preview } : {}) });
          if (name === "worker_start") this.phase = "delegated";
          else if (name === "worker_result") this.phase = "validating";
          events.push({ type: "tool_start", id: call.id, name, summary, ...(depth ? { depth } : {}) });
        }
        if (replay) {
          if (event.reasoningContent) events.push({ type: "thinking_delta", text: event.reasoningContent, ...(depth ? { depth } : {}) });
          const content = textContent(event.content);
          if (content) events.push({ type: "text_delta", text: content, ...(depth ? { depth } : {}) });
          if (event.refusal) events.push({ type: "text_delta", text: event.refusal, ...(depth ? { depth } : {}) });
        }
        return events;
      }
      case "tool.response": {
        const call = this.toolNames.get(event.toolCallId);
        return [
          {
            type: "tool_end",
            id: event.toolCallId,
            name: call?.name ?? "tool",
            result: { output: event.content, isError: false },
            ...(depth ? { depth } : {}),
          },
        ];
      }
      case "mcp.auth_required":
        return [
          {
            type: "notice",
            text: `MCP authorization required for ${event.mcpServers
              .map((server) => `${server.name}: ${server.authUrl}`)
              .join(", ")}. Complete authorization, then retry your prompt.`,
          },
        ];
      case "tool.response_required":
        return [
          {
            type: "notice",
            text: `TrueForge is waiting for ${event.toolCalls.length} external tool response${event.toolCalls.length === 1 ? "" : "s"}. The pending turn was preserved.`,
          },
        ];
      case "tool.approval_required":
        return [];
      case "turn.done": {
        if (!replay) return [];
        const metrics = event.state.metrics;
        const events: LoopEvent[] = [];
        if (event.state.status === "error") {
          events.push({ type: "notice", text: event.state.message });
        }
        events.push(
          turnEndEvent(
            event.state.status,
            usageFromMetrics(metrics),
            metrics?.totalCostInUsd,
          ),
        );
        return events;
      }
    }
  }

  private async *streamEvents(
    stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  ): AsyncGenerator<
    { event: TrueForgeApi.TurnStreamingEvent; sequenceNumber: number },
    void,
    undefined
  > {
    const metadataStream = stream as Partial<MetadataStream>;
    if (typeof metadataStream.withMetadata === "function") {
      for await (const envelope of metadataStream.withMetadata()) {
        yield {
          event: envelope.data,
          sequenceNumber: sequenceNumber(
            envelope.id,
            this.state.lastSequenceNumber + 1,
          ),
        };
      }
      return;
    }
    for await (const event of stream) {
      yield { event, sequenceNumber: this.state.lastSequenceNumber + 1 };
    }
  }

  private async requestApprovals(
    event: TrueForgeApi.ToolApprovalRequiredEvent,
    approve: BackendTurnOptions["approveAction"],
  ): Promise<TrueForgeApi.UserToolApprovalEvent[]> {
    const decisions: TrueForgeApi.UserToolApprovalEvent[] = [];
    for (const call of event.toolCalls) {
      const known = this.toolNames.get(call.id);
      const request: BackendApprovalRequest = {
        toolCallId: call.id,
        threadId: event.threadId,
        toolName: known?.name ?? "TrueForge tool",
        title:
          known?.name === "workspace_apply_patch"
            ? `apply the validated candidate to ${this.root}`
            : known?.name === "workspace_undo"
              ? `restore a Rocky checkpoint in ${this.root}`
              : known?.summary ?? call.id,
        ...(known?.preview || known?.summary ? { preview: known?.preview ?? known?.summary } : {}),
      };
      const decision = approve
        ? await approve(request)
        : { allow: false, reason: "no approval channel is available" };
      decisions.push({
        type: "user.tool_approval",
        threadId: event.threadId,
        toolCallId: call.id,
        approval: decision.allow
          ? { status: "allow" }
          : { status: "deny", ...(decision.reason ? { reason: decision.reason } : {}) },
      });
    }
    return decisions;
  }

  private async *consumeStream(
    sessionId: string,
    initialStream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
    options: BackendTurnOptions,
  ): AsyncGenerator<LoopEvent, StreamOutcome, undefined> {
    let stream = initialStream;
    let terminal: TrueForgeApi.TurnDoneEvent | undefined;
    const approvals: TrueForgeApi.UserToolApprovalEvent[] = [];
    const externalActions: StreamOutcome["externalActions"] = [];
    let reconnects = 0;

    for (;;) {
      try {
        for await (const item of this.streamEvents(stream)) {
          const { event } = item;
          this.state.lastSequenceNumber = item.sequenceNumber;
          if (event.type === "turn.created") this.state.activeTurnId = event.turnId;
          this.saveState();
          if (event.type === "tool.approval_required") {
            this.phase = "awaiting_approval";
            yield {
              type: "phase",
              phase: "awaiting_approval",
              detail: `${event.toolCalls.length} tool call(s)`,
            };
            approvals.push(...(await this.requestApprovals(event, options.approveAction)));
          }
          if (event.type === "mcp.auth_required" || event.type === "tool.response_required") {
            externalActions.push(event);
          }
          if (event.type === "turn.done") terminal = event;
          for (const mapped of this.mapEvent(event)) yield mapped;
        }
        if (!terminal && approvals.length === 0 && externalActions.length === 0) {
          throw new Error("TrueForge stream ended before turn.done");
        }
        return { ...(terminal ? { terminal } : {}), approvals, externalActions };
      } catch (error) {
        if (options.signal.aborted) throw error;
        if (!this.state.activeTurnId || reconnects >= 2) throw error;
        reconnects++;
        yield {
          type: "infrastructure",
          component: "trueforge",
          status: "connecting",
          detail: `reconnecting (${reconnects}/2)`,
        };
        stream = await this.client.sessions.subscribeToTurn(
          sessionId,
          this.state.activeTurnId,
          { afterSequenceNumber: this.state.lastSequenceNumber },
          { abortSignal: options.signal, timeoutInSeconds: 3_600 },
        );
      }
    }
  }

  async *turn(prompt: string, options: BackendTurnOptions): AsyncGenerator<LoopEvent, void, undefined> {
    let finalStatus = "done";
    let finalUsage = emptyUsage();
    let finalCostUsd: number | undefined;
    try {
      const sessionId = await this.ensureSession();
      this.connection = "ready";
      this.phase = "planning";
      yield { type: "phase", phase: "planning", detail: "TrueForge root agent" };

      let promptStarted = !this.state.activeTurnId;
      let inputs: TrueForgeApi.TurnInputItem[] = promptStarted ? [this.userInput(prompt, options.extraSystem)] : [];
      let pendingStream: AsyncIterable<TrueForgeApi.TurnStreamingEvent> | undefined;
      let resumeMcpAuth = false;
      if (this.state.activeTurnId) {
        this.connection = "connecting";
        const activeTurnId = this.state.activeTurnId;
        yield {
          type: "infrastructure",
          component: "trueforge",
          status: "connecting",
          detail: `resuming turn ${activeTurnId.slice(0, 8)}`,
        };
        const persistedTurn = await this.client.sessions.getTurn(sessionId, activeTurnId);
        if (persistedTurn.data.state.status === "running") {
          pendingStream = await this.client.sessions.subscribeToTurn(
            sessionId,
            activeTurnId,
            { afterSequenceNumber: this.state.lastSequenceNumber },
            { abortSignal: options.signal, timeoutInSeconds: 3_600 },
          );
        } else {
          const events = await this.client.sessions.listTurnEvents(sessionId, activeTurnId, {
            limit: 100,
            order: "asc",
          });
          for await (const event of events) {
            // replay() owns user-visible history. This silent pass only
            // reconstructs tool metadata needed to resolve pending actions.
            this.mapEvent(event, true);
          }
          if (persistedTurn.data.state.status === "error") {
            yield { type: "notice", text: persistedTurn.data.state.message };
          }
          if (persistedTurn.data.state.status === "done") {
            const externalActions = persistedTurn.data.state.requiredActions.filter(
              (
                action,
              ): action is
                | TrueForgeApi.McpAuthRequiredEvent
                | TrueForgeApi.ToolResponseRequiredEvent =>
                action.type === "mcp.auth_required" ||
                action.type === "tool.response_required",
            );
            const responseActions = externalActions.filter(
              (action): action is TrueForgeApi.ToolResponseRequiredEvent =>
                action.type === "tool.response_required",
            );
            if (responseActions.length > 0) {
              this.phase = "awaiting_approval";
              yield {
                type: "phase",
                phase: "awaiting_approval",
                detail: `${externalActions.length} external action(s)`,
              };
              for (const action of externalActions) {
                for (const mapped of this.mapEvent(action, true)) yield mapped;
              }
              this.connection = "ready";
              return;
            }
            if (externalActions.length > 0) {
              for (const action of externalActions) {
                for (const mapped of this.mapEvent(action, true)) yield mapped;
              }
              resumeMcpAuth = true;
              this.phase = "planning";
            }
            if (!resumeMcpAuth) {
              for (const action of persistedTurn.data.state.requiredActions) {
                if (action.type !== "tool.approval_required") continue;
                this.phase = "awaiting_approval";
                yield {
                  type: "phase",
                  phase: "awaiting_approval",
                  detail: `${action.toolCalls.length} tool call(s)`,
                };
                inputs.push(...(await this.requestApprovals(action, options.approveAction)));
              }
            }
          }
          if (inputs.length === 0 && !resumeMcpAuth) {
            this.clearActiveTurn();
            yield {
              type: "infrastructure",
              component: "trueforge",
              status: "done",
              detail: "persisted turn recovered",
            };
            inputs = [this.userInput(prompt, options.extraSystem)];
            promptStarted = true;
          }
        }
        this.connection = "ready";
      }

      let approvalRounds = 0;
      while (pendingStream || resumeMcpAuth || inputs.length > 0) {
        if (options.signal.aborted) throw new Error("aborted");
        let stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>;
        if (pendingStream) {
          stream = pendingStream;
          pendingStream = undefined;
        } else {
          this.state.lastSequenceNumber = 0;
          const request = resumeMcpAuth ? {} : { input: inputs };
          resumeMcpAuth = false;
          stream = await this.client.sessions.createTurnStream(
            sessionId,
            request,
            { abortSignal: options.signal, timeoutInSeconds: 3_600 },
          );
          if (!this.state.snapshotAttached) {
            this.state.snapshotAttached = true;
            this.saveState();
          }
        }
        inputs = [];
        const outcome = yield* this.consumeStream(sessionId, stream, options);
        inputs.push(...outcome.approvals);

        if (outcome.terminal) {
          finalStatus = outcome.terminal.state.status;
          finalUsage = addUsage(finalUsage, usageFromMetrics(outcome.terminal.state.metrics));
          if (outcome.terminal.state.metrics?.totalCostInUsd !== undefined) {
            finalCostUsd =
              (finalCostUsd ?? 0) + outcome.terminal.state.metrics.totalCostInUsd;
          }
          if (outcome.terminal.state.status === "error") {
            yield { type: "notice", text: outcome.terminal.state.message };
          }
        }

        const externalActions = new Map(
          outcome.externalActions.map((action) => [action.id, action] as const),
        );
        if (outcome.terminal?.state.status === "done") {
          for (const action of outcome.terminal.state.requiredActions) {
            if (
              action.type === "mcp.auth_required" ||
              action.type === "tool.response_required"
            ) {
              externalActions.set(action.id, action);
            }
          }
        }
        if (externalActions.size > 0) {
          this.phase = "awaiting_approval";
          yield {
            type: "phase",
            phase: "awaiting_approval",
            detail: `${externalActions.size} external action(s)`,
          };
          const streamedActionIds = new Set(
            outcome.externalActions.map((action) => action.id),
          );
          for (const action of externalActions.values()) {
            if (streamedActionIds.has(action.id)) continue;
            for (const mapped of this.mapEvent(action)) yield mapped;
          }
          yield turnEndEvent(finalStatus, finalUsage, finalCostUsd);
          return;
        }

        if (inputs.length > 0) {
          approvalRounds++;
          if (approvalRounds > 10) throw new Error("TrueForge approval resume limit exceeded");
          this.phase = "planning";
          continue;
        }

        if (!promptStarted) {
          if (!outcome.terminal) throw new Error("recovered TrueForge turn did not reach a terminal state");
          this.clearActiveTurn();
          yield {
            type: "infrastructure",
            component: "trueforge",
            status: "done",
            detail: "persisted turn recovered",
          };
          yield turnEndEvent(finalStatus, finalUsage, finalCostUsd);
          finalStatus = "done";
          finalUsage = emptyUsage();
          finalCostUsd = undefined;
          inputs = [this.userInput(prompt, options.extraSystem)];
          promptStarted = true;
          this.phase = "planning";
        }
      }

      this.clearActiveTurn();
      this.phase = "idle";
      yield { type: "phase", phase: "idle" };
      yield turnEndEvent(finalStatus, finalUsage, finalCostUsd);
    } catch (error) {
      this.phase = "idle";
      if (options.signal.aborted) {
        await this.cancel().catch(() => undefined);
        this.clearActiveTurn();
        yield turnEndEvent("cancelled", finalUsage);
        return;
      }
      this.connection = "error";
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.state.sessionId) return;
    await this.client.sessions.cancel(this.state.sessionId);
  }

  status(): BackendStatus {
    return {
      kind: "trueforge",
      connection: this.connection,
      ...(this.state.sessionId ? { sessionId: this.state.sessionId } : {}),
      ...(this.state.activeTurnId ? { activeTurnId: this.state.activeTurnId } : {}),
      sandbox: this.sandbox,
      phase: this.phase,
    };
  }

  async sessions(): Promise<unknown> {
    const page = await this.client.sessions.list({ limit: 20 });
    return page.data;
  }

  async *replay(): AsyncGenerator<LoopEvent, void, undefined> {
    if (!this.state.sessionId) return;
    this.connection = "connecting";
    try {
      const page = await this.client.sessions.listEvents(this.state.sessionId, { limit: 100 });
      const items: TrueForgeApi.SessionEventItem[] = [];
      for await (const item of page) items.push(item);
      for (const item of items.reverse()) {
        for (const event of this.mapEvent(item.event as TrueForgeApi.TurnStreamingEvent, true)) yield event;
      }
      this.phase = "idle";
      this.connection = "ready";
    } catch (error) {
      this.phase = "idle";
      this.connection = "error";
      throw error;
    }
  }
}
