import { makeRegistry, type ErasedTool, type ToolRegistry } from "../tools/index.ts";
import type { AgentOutcome, AgentRequest, ToolContext, ToolResult } from "../tools/types.ts";
import { toSpecs } from "../tools/types.ts";
import { runCheck } from "./check.ts";
import { compactSession, type CompactionOptions } from "./compact.ts";
import { capToolResult } from "./hygiene.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { Session } from "./session.ts";
import type {
  ContentBlock,
  Message,
  StopReason,
  SystemSegment,
  ToolUseBlock,
  Usage,
} from "./types.ts";

export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: string };

export type LoopDeps = {
  registry: ToolRegistry;
  /** Gate every tool call. Defaults to allow-all; the CLI supplies the engine. */
  approve?: (
    tool: ErasedTool,
    input: unknown,
    ctx: ToolContext,
  ) => Promise<PermissionDecision>;
  /** Extra system-prompt segments (project memory, plan-mode banner). */
  extraSystem?: string[];
  maxIterations?: number;
  /**
   * Give up after this many consecutive iterations in which *every* tool call
   * was refused. Permission is not going to appear by asking again, and without
   * this the model burns `maxIterations` against a wall.
   */
  maxDeniedStreak?: number;
  /** Disable auto-compaction (tests, and sub-agents with their own budget). */
  autoCompact?: boolean;
  compaction?: CompactionOptions;
  /** False inside a sub-agent: delegation goes one level deep, not N. */
  subAgents?: boolean;
};

/**
 * Every event carries an optional `depth`: 0 (or absent) is this loop's own
 * work, 1 is a sub-agent's, forwarded so the renderer can indent it. Nothing
 * in the loop branches on it — it exists for presentation.
 */
export type LoopEvent =
  | {
      type: "compacted";
      droppedMessages: number;
      before: number;
      after: number;
      recap: string;
      depth?: number;
    }
  | { type: "thinking_delta"; text: string; depth?: number }
  | { type: "text_delta"; text: string; depth?: number }
  | { type: "tool_start"; id: string; name: string; summary: string; depth?: number }
  | {
      type: "tool_denied";
      id: string;
      name: string;
      summary: string;
      reason: string;
      depth?: number;
    }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; depth?: number }
  | { type: "check"; command: string; ok: boolean; summary: string; depth?: number }
  | { type: "turn_end"; stopReason: StopReason; usage: Usage; costUsd?: number; depth?: number }
  | { type: "notice"; text: string; depth?: number }
  | {
      type: "phase";
      phase: "planning" | "delegated" | "validating" | "healing" | "awaiting_approval" | "idle";
      detail?: string;
      depth?: number;
    }
  | {
      type: "infrastructure";
      component: "trueforge" | "sandbox" | "mcp" | "worker";
      status: "connecting" | "ready" | "running" | "done" | "error";
      detail: string;
      depth?: number;
    }
  | { type: "thread_start"; id: string; title: string; agent: string; depth?: number }
  | { type: "thread_end"; id: string; ok: boolean; detail?: string; depth?: number };

/** Re-tag an event one level deeper. Used when forwarding a child's stream. */
const deeper = (ev: LoopEvent): LoopEvent => ({ ...ev, depth: (ev.depth ?? 0) + 1 });

const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === "tool_use";

/**
 * The agent loop: model → tool calls → tool results → model, until the model
 * stops calling tools.
 *
 * Everything it does is yielded as an event, so the TUI, the non-interactive
 * runner, and the test harness all observe the same thing. It never writes to
 * stdout and never throws for a tool failure — a tool error is a `tool_result`
 * the model gets to see and recover from.
 */
export async function* runTurn(
  session: Session,
  userInput: string,
  deps: LoopDeps,
  signal: AbortSignal,
): AsyncGenerator<LoopEvent, void, undefined> {
  const approve = deps.approve ?? (async () => ({ allow: true }) as const);
  const maxIterations = deps.maxIterations ?? 100;
  const maxDeniedStreak = deps.maxDeniedStreak ?? 2;
  const autoCompact = deps.autoCompact ?? true;
  let deniedStreak = 0;
  let compactedThisTurn = false;

  const system: SystemSegment[] = buildSystemPrompt(session.cwd, deps.extraSystem ?? []);
  const tools = toSpecs([...deps.registry.values()]);

  session.append({ role: "user", content: [{ type: "text", text: userInput }] });

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal.aborted) {
      yield { type: "turn_end", stopReason: "aborted", usage: zero() };
      return;
    }

    // Compact before the request, so the request itself fits. At most once per
    // turn: if the kept tail is *still* over threshold, a second pass would buy
    // one more summarization call and drop the work in progress to pay for it.
    // The flag is per-`runTurn`, so the next user turn may compact again.
    if (autoCompact && !compactedThisTurn && session.needsCompaction) {
      const outcome = await compactSession(session, signal, deps.compaction);
      if (outcome.ok) {
        compactedThisTurn = true;
        yield {
          type: "compacted",
          droppedMessages: outcome.droppedMessages,
          before: outcome.before,
          after: outcome.after,
          recap: outcome.recap,
        };
      } else {
        // Nothing safe to drop. Say so once rather than retrying every turn.
        yield {
          type: "notice",
          text: `Context is ${Math.round(session.contextUsed * 100)}% full but ${outcome.reason}.`,
        };
        session.resetContextMeter();
      }
    }

    let assistant: Message | undefined;
    let stopReason: StopReason = "end_turn";
    let usage: Usage = zero();

    for await (const ev of session.provider.stream({
      model: session.model,
      system,
      messages: session.messages,
      tools,
      maxTokens: session.config.maxTokens,
      effort: session.config.effort,
      thinking: session.config.thinking,
      signal,
    })) {
      switch (ev.type) {
        case "text_delta":
          yield { type: "text_delta", text: ev.text };
          break;
        case "thinking_delta":
          yield { type: "thinking_delta", text: ev.text };
          break;
        case "message_end":
          assistant = ev.message;
          stopReason = ev.stopReason;
          usage = ev.usage;
          break;
        default:
          break;
      }
    }

    if (!assistant) {
      yield { type: "turn_end", stopReason: "aborted", usage: zero() };
      return;
    }

    session.append(assistant);
    session.recordUsage(usage);
    session.turns++;

    // A server-side tool paused the turn; re-send to resume. No tool results.
    if (stopReason === "pause_turn") continue;

    const calls = assistant.content.filter(isToolUse);
    if (stopReason !== "tool_use" || calls.length === 0) {
      if (stopReason === "max_tokens") {
        yield {
          type: "notice",
          text: "Response hit max_tokens and was truncated. Raise maxTokens or narrow the task.",
        };
      }
      if (stopReason === "refusal") {
        yield { type: "notice", text: "The model declined this request." };
      }
      yield { type: "turn_end", stopReason, usage };
      return;
    }

    // Every tool_use block must get exactly one tool_result, in one user
    // message, or the next request is rejected. Splitting them across messages
    // also trains the model out of parallel tool calls.
    const results: ContentBlock[] = [];
    let executed = 0;
    let denied = 0;
    let editedOk = false;
    for await (const ev of executeCalls(calls, session, deps, approve, signal)) {
      if (ev.kind === "block") {
        results.push(ev.block);
        continue;
      }
      if (ev.event.type === "tool_denied") denied++;
      if (ev.event.type === "tool_end") {
        executed++;
        if (
          !ev.event.result.isError &&
          (ev.event.name === "edit_file" || ev.event.name === "write_file")
        ) {
          editedOk = true;
        }
      }
      yield ev.event;
    }

    // The batch changed a file: run the project's check once, and put any
    // failure in the same message as the tool results — the model fixes what
    // it just broke now, not after reporting success. Per batch is the
    // debounce: three edits in one assistant message pay for one check.
    if (editedOk && session.config.check && !session.checkBroken && !signal.aborted) {
      const outcome = await runCheck(session.config.check, session.projectDir, signal);
      if (outcome.kind === "broken") {
        // A check that cannot run must not tax every batch or mislead the model.
        session.checkBroken = true;
        yield { type: "notice", text: outcome.notice };
      } else {
        yield {
          type: "check",
          command: session.config.check.command,
          ok: outcome.kind === "pass",
          summary: outcome.kind === "fail" ? outcome.summary : "",
        };
        // Only failures reach the model; a passing check costs zero tokens.
        if (outcome.kind === "fail") {
          results.push({ type: "text", text: outcome.feedback });
        }
      }
    }

    // The transcript must stay valid even when we stop early: every tool_use
    // needs its tool_result before this turn ends.
    session.append({ role: "user", content: results });

    if (signal.aborted) {
      yield { type: "turn_end", stopReason: "aborted", usage };
      return;
    }

    deniedStreak = executed === 0 && denied > 0 ? deniedStreak + 1 : 0;
    if (deniedStreak >= maxDeniedStreak) {
      yield {
        type: "notice",
        text:
          `Stopping: ${deniedStreak} consecutive turns had every tool call refused. ` +
          `Grant permission (--yolo, --permission-mode, or an allow rule) and retry.`,
      };
      yield { type: "turn_end", stopReason: "denied", usage };
      return;
    }
  }

  yield {
    type: "notice",
    text: `Stopped after ${maxIterations} tool iterations without finishing.`,
  };
  yield { type: "turn_end", stopReason: "max_iterations", usage: zero() };
}

type Emission =
  | { kind: "event"; event: LoopEvent }
  | { kind: "block"; block: ContentBlock };

/**
 * Read-only calls in a batch run concurrently; anything that mutates runs
 * serially, because two edits to the same file must not interleave.
 */
async function* executeCalls(
  calls: ToolUseBlock[],
  session: Session,
  deps: LoopDeps,
  approve: NonNullable<LoopDeps["approve"]>,
  signal: AbortSignal,
): AsyncGenerator<Emission, void, undefined> {
  /**
   * One context per call, so each call owns its sub-agent event sink —
   * read-only calls in a batch run concurrently and must not share a queue.
   * `cwd` still round-trips through the Session, so a `bash` cd is visible to
   * every later call exactly as before.
   */
  const makeCtx = (sink: (ev: LoopEvent) => void): ToolContext => {
    const ctx: ToolContext = {
      cwd: session.cwd,
      setCwd: (dir) => {
        session.cwd = dir;
        ctx.cwd = dir;
      },
      setTodos: (items) => {
        session.todos = items;
      },
      sessionDir: session.sessionDir,
      archive: session.archive,
      config: session.config,
      signal,
      onSubagentEvent: sink,
      ...(deps.subAgents === false
        ? {}
        : {
            runAgent: (req: AgentRequest) =>
              runSubAgent(session, deps, approve, req, signal, sink),
          }),
    };
    return ctx;
  };

  const allReadOnly = calls.every(
    (c) => deps.registry.get(c.name)?.readOnly === true,
  );

  const run = async (call: ToolUseBlock): Promise<Emission[]> => {
    const out: Emission[] = [];
    // Whatever a sub-agent emits while this call runs, in arrival order.
    const nested: LoopEvent[] = [];
    const ctx = makeCtx((ev) => nested.push(ev));
    const tool = deps.registry.get(call.name);

    if (!tool) {
      out.push(toolResult(call, `Unknown tool: ${call.name}`, true));
      return out;
    }
    if (signal.aborted) {
      out.push(toolResult(call, "Interrupted by the user; not executed.", true));
      return out;
    }

    const decision = await approve(tool, call.input, ctx);
    if (!decision.allow) {
      out.push({
        kind: "event",
        event: {
          type: "tool_denied",
          id: call.id,
          name: call.name,
          // Without this the user cannot tell *what* was refused.
          summary: tool.summarize(call.input),
          reason: decision.reason,
        },
      });
      out.push(toolResult(call, `Denied by the user: ${decision.reason}`, true));
      return out;
    }

    out.push({
      kind: "event",
      event: {
        type: "tool_start",
        id: call.id,
        name: call.name,
        summary: tool.summarize(call.input),
      },
    });

    let result: ToolResult;
    try {
      result = await tool.run(call.input, ctx);
    } catch (e) {
      // A crashing handler is a bug, but the model should still see it and the
      // session must stay alive.
      result = {
        output: `${call.name} threw: ${(e as Error).message}`,
        isError: true,
      };
    }

    // One cap for every tool, so a new tool cannot forget to bound its output.
    result = capToolResult(result, tool.name, ctx.config.maxToolResultBytes, ctx.archive);

    // Between tool_start and tool_end, so the child's work reads as "while the
    // task was running…". Batched, not live: the sub-agent has already finished.
    for (const ev of nested) out.push({ kind: "event", event: ev });

    out.push({ kind: "event", event: { type: "tool_end", id: call.id, name: call.name, result } });
    out.push(toolResult(call, result.output, result.isError));
    return out;
  };

  if (allReadOnly && calls.length > 1) {
    const settled = await Promise.all(calls.map(run));
    for (const batch of settled) for (const e of batch) yield e;
    return;
  }

  for (const call of calls) {
    for (const e of await run(call)) yield e;
  }
}

/**
 * Run a sub-agent: a fresh Session against the same provider, model, and
 * permission gate, with its own context window. Only its collected prose comes
 * back; its exploration never lands in the parent's transcript — that isolation
 * is the entire point.
 *
 * The child's tool calls go through the same `approve` as the parent's, so in
 * ask mode a sub-agent's write still prompts the user, and deny rules hold.
 *
 * `onEvent` receives every child event re-tagged one level deeper, so the
 * parent's stream can show what the child is doing instead of a silent
 * spinner. It is a tee: the outcome below is still built from the same events.
 */
async function runSubAgent(
  parent: Session,
  deps: LoopDeps,
  approve: NonNullable<LoopDeps["approve"]>,
  req: AgentRequest,
  signal: AbortSignal,
  onEvent?: (ev: LoopEvent) => void,
): Promise<AgentOutcome> {
  const tools = [...deps.registry.values()].filter((t) =>
    req.readOnly ? t.readOnly : t.name !== "task",
  );

  const child = new Session({
    cwd: parent.cwd,
    config: parent.config,
    provider: parent.provider,
    projectDir: parent.projectDir,
    id: `${parent.id}-task${parent.turns}`,
  });
  child.model = parent.model;

  const childDeps: LoopDeps = {
    registry: makeRegistry(tools),
    approve,
    // Project memory flows down; the child works in the same project.
    ...(deps.extraSystem ? { extraSystem: deps.extraSystem } : {}),
    // A sub-task that needs 100 iterations was not a sub-task.
    maxIterations: 30,
    subAgents: false,
  };

  const answer: string[] = [];
  let toolCalls = 0;
  let turns = 0;
  let finished = false;

  try {
    for await (const ev of runTurn(child, req.prompt, childDeps, signal)) {
      onEvent?.(deeper(ev));
      if (ev.type === "text_delta") answer.push(ev.text);
      if (ev.type === "tool_end" || ev.type === "tool_denied") toolCalls++;
      if (ev.type === "turn_end") {
        turns = child.turns;
        // "Gave up" is not "finished": a capped or permission-stalled child
        // must report incomplete, or its partial prose reads as the answer.
        finished =
          ev.stopReason !== "aborted" &&
          ev.stopReason !== "max_iterations" &&
          ev.stopReason !== "denied";
      }
    }
  } finally {
    // The child's spend is real even when it dies mid-flight.
    parent.absorbUsage(child.totalUsage);
  }

  return {
    answer: answer.join("").trim(),
    toolCalls,
    turns,
    incomplete: !finished,
  };
}

const toolResult = (call: ToolUseBlock, content: string, isError: boolean): Emission => ({
  kind: "block",
  block: { type: "tool_result", tool_use_id: call.id, content, is_error: isError },
});

const zero = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});
