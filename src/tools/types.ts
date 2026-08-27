import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { Archiver } from "../core/archive.ts";
// Type-only: erased at runtime, so the loop ↔ tools cycle never exists.
import type { LoopEvent } from "../core/loop.ts";
import type { JSONSchema, TodoItem, ToolSpec } from "../core/types.ts";

/**
 * Everything a tool handler is allowed to touch. Handlers are pure functions of
 * (input, ctx): no globals, no process.cwd(), no direct stdout. This is what
 * makes them unit-testable, including their failure paths.
 */
export interface ToolContext {
  /** Session working directory. `bash` may mutate it via `setCwd`. */
  cwd: string;
  setCwd(dir: string): void;
  /** Where full (untruncated) tool outputs are archived. */
  sessionDir: string;
  /** Persist a full output and get back a path the model can re-read. */
  archive: Archiver;
  config: Config;
  signal: AbortSignal;
  /**
   * Run a sub-agent to completion and return its report. Supplied by the loop;
   * absent inside a sub-agent, because nesting multiplies cost without adding
   * capability — one level of delegation is the feature.
   */
  runAgent?(req: AgentRequest): Promise<AgentOutcome>;
  /**
   * Replace the session's todo list. Supplied by the loop; the same idiom as
   * `setCwd` — state lives on the Session, the tool stays a pure function.
   */
  setTodos?(items: TodoItem[]): void;
  /**
   * Loop driver hooks this so a tool that runs a sub-agent (currently just
   * `task`) can forward child events to the parent's stream. The event already
   * carries `depth: 1`; the tool itself never has to call it — the driver
   * wires the same sink into `runAgent`.
   */
  onSubagentEvent?: (ev: LoopEvent) => void;
}

export type AgentRequest = {
  /** The sub-agent's complete instructions. It starts with no other context. */
  prompt: string;
  /** Restrict the child to read-only tools: explore and report, change nothing. */
  readOnly: boolean;
};

export type AgentOutcome = {
  /** Everything the child said — its report. */
  answer: string;
  toolCalls: number;
  turns: number;
  /** True when the child was interrupted before it could finish. */
  incomplete: boolean;
};

export type ToolResult = {
  /** Exactly what the model sees. Already truncated. */
  output: string;
  isError: boolean;
  /** Structured detail for the TUI (diffs, exit codes). Never sent to the model. */
  meta?: Record<string, unknown>;
};

export const ok = (output: string, meta?: Record<string, unknown>): ToolResult =>
  meta ? { output, isError: false, meta } : { output, isError: false };

export const fail = (output: string, meta?: Record<string, unknown>): ToolResult =>
  meta ? { output, isError: true, meta } : { output, isError: true };

export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<I>;
  /** JSON Schema sent to the provider. Derived from `schema`. */
  readonly jsonSchema: JSONSchema;
  /** Read-only tools may run in parallel and skip permission prompts. */
  readonly readOnly: boolean;
  /** One-line summary rendered next to the spinner while running. */
  summarize(input: I): string;
  /**
   * What this call will do, shown in the permission prompt *before* it runs.
   * Must have no side effects. Returning undefined means "nothing to preview".
   */
  preview?(input: I, ctx: ToolContext): string | undefined;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A tool with its input type erased, so tools with different input shapes can
 * live in one registry. Validation moves inside `run`/`summarize`, which is
 * where it belongs anyway: model-supplied input is untrusted until parsed.
 */
export interface ErasedTool {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: JSONSchema;
  readonly readOnly: boolean;
  summarize(input: unknown): string;
  preview(input: unknown, ctx: ToolContext): string | undefined;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function erase<I>(tool: Tool<I>): ErasedTool {
  return {
    name: tool.name,
    description: tool.description,
    jsonSchema: tool.jsonSchema,
    readOnly: tool.readOnly,
    summarize(input) {
      const parsed = tool.schema.safeParse(input);
      return parsed.success ? tool.summarize(parsed.data) : tool.name;
    },
    preview(input, ctx) {
      if (!tool.preview) return undefined;
      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) return undefined;
      try {
        return tool.preview(parsed.data, ctx);
      } catch {
        // A preview is a courtesy; never let it block or crash a prompt.
        return undefined;
      }
    },
    async run(input, ctx) {
      const parsed = parseInput(tool, input);
      if (!parsed.ok) return fail(parsed.error);
      return tool.run(parsed.value, ctx);
    },
  };
}

/** Build the provider-facing spec list from a registry. */
export const toSpecs = (tools: readonly ErasedTool[]): ToolSpec[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema,
  }));

/**
 * zod → JSON Schema. Strips `$schema`, which Anthropic rejects, and forces
 * `additionalProperties: false` so the model can't invent parameters.
 */
export function jsonSchemaOf(schema: z.ZodType<unknown>): JSONSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
  delete raw["$schema"];
  raw["additionalProperties"] = false;
  return raw;
}

/** Validate model-supplied input at the boundary; trust it internally. */
export function parseInput<I>(
  tool: Tool<I>,
  input: unknown,
): { ok: true; value: I } | { ok: false; error: string } {
  const parsed = tool.schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid input for ${tool.name}: ${issues}` };
}
