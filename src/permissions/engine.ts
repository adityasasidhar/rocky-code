import type { PermissionMode } from "../config/schema.ts";
import type { PermissionDecision } from "../core/loop.ts";
import type { ErasedTool, ToolContext } from "../tools/types.ts";
import {
  BUILTIN_DENY,
  evaluateBash,
  parseRules,
  suggestRule,
  type Rule,
} from "./rules.ts";
import { loadSettings, persistAllow } from "./settings.ts";

/** What the user is being asked to approve. */
export type PermissionRequest = {
  tool: Pick<ErasedTool, "name">;
  /** One-line description: the full command, or the file being edited. */
  title: string;
  /** The full command for bash; undefined otherwise. */
  command?: string;
  /** A colorized diff or file preview, if the tool can produce one. */
  preview?: string;
  /** Consequential external actions must be approved individually. */
  onceOnly?: boolean;
  /** The rule that "always allow" would add, if one can be suggested. */
  suggestion?: string;
};

export type Answer =
  | { kind: "once" }
  | { kind: "no"; reason?: string }
  /** Allow for the rest of this session. */
  | { kind: "session" }
  /** Allow for this session and write it to .rocky/settings.json. */
  | { kind: "persist" };

export type AskFn = (request: PermissionRequest) => Promise<Answer>;

export type EngineOptions = {
  mode: PermissionMode;
  allow: readonly string[];
  deny: readonly string[];
  projectDir: string;
  ask: AskFn;
  /** Emitted for the yolo banner and persistence confirmations. */
  notify?: (message: string) => void;
};

const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

const denied = (reason: string): PermissionDecision => ({ allow: false, reason });
const allowed: PermissionDecision = { allow: true };

/**
 * Decides whether a tool call may run.
 *
 * Order of precedence, highest first:
 *   1. deny rules — builtin and configured. These win in *every* mode,
 *      including yolo. Yolo means "stop asking", not "disable the brakes".
 *   2. read-only tools — never prompt.
 *   3. plan mode — everything that could mutate is refused, no prompt. The
 *      point of plan mode is that nothing can happen, so there is nothing to
 *      ask about; the denial text tells the model how the user lifts it.
 *   4. yolo — allow.
 *   5. allow rules — config, persisted settings, and this session's grants.
 *   6. auto-edit — file edits allowed; bash still asks.
 *   7. ask the user.
 */
export class PermissionEngine {
  private readonly deny: Rule[];
  private readonly configAllow: Rule[];
  /** Grants added by answering "always" during this session. */
  private readonly sessionAllow: Rule[] = [];
  /** Tools blanket-approved this session, e.g. edit_file. */
  private readonly sessionTools = new Set<string>();
  private warned = false;

  constructor(private readonly opts: EngineOptions) {
    const settings = loadSettings(opts.projectDir);
    this.deny = parseRules([...BUILTIN_DENY, ...opts.deny]);
    this.configAllow = parseRules([...opts.allow, ...settings.allow]);
    for (const name of settings.allowTools) this.sessionTools.add(name);
  }

  get mode(): PermissionMode {
    return this.opts.mode;
  }

  /** `/plan` toggles at runtime; grants and rules survive the switch. */
  setMode(mode: PermissionMode): void {
    this.opts.mode = mode;
  }

  /**
   * Swap the interactive ask channel after construction. The footer UI can
   * only exist once the terminal renderer is up, which is long after the
   * engine is built — so the dialog-backed ask binds late.
   */
  setAsk(ask: AskFn): void {
    this.opts.ask = ask;
  }

  /** Route a TrueForge approval through the same TTY/footer channel. */
  askExternal(request: PermissionRequest): Promise<Answer> {
    if (this.opts.mode === "plan") {
      return Promise.resolve({
        kind: "no",
        reason: "plan mode is read-only; leave plan mode before approving a consequential action",
      });
    }
    return this.opts.ask(request);
  }

  /** For `/permissions`. */
  describe(): { mode: PermissionMode; allow: string[]; deny: string[] } {
    return {
      mode: this.opts.mode,
      allow: [...this.configAllow, ...this.sessionAllow].map((r) => r.source),
      deny: this.deny.map((r) => r.source),
    };
  }

  async check(
    tool: ErasedTool,
    input: unknown,
    ctx: ToolContext,
  ): Promise<PermissionDecision> {
    const command = tool.name === "bash" ? commandOf(input) : undefined;

    // 1. Deny wins everywhere, including yolo.
    if (command !== undefined) {
      const verdict = evaluateBash(command, [], this.deny);
      if (verdict.kind === "deny") {
        return denied(
          `blocked by deny rule "${verdict.rule.source}" ` +
            `(matched: ${verdict.segment.raw})`,
        );
      }
    }

    // 2. Reading never needs permission.
    if (tool.readOnly) return allowed;

    // 3. Plan mode refuses rather than asks: the mode's promise is that
    // nothing can change, and a prompt would offer to break that promise.
    if (this.opts.mode === "plan") {
      return denied(
        "plan mode is read-only. Finish investigating, present the plan, and " +
          "ask the user to leave plan mode (/plan) before making changes.",
      );
    }

    // 4. Yolo.
    if (this.opts.mode === "yolo") {
      if (!this.warned) {
        this.warned = true;
        this.opts.notify?.(
          "yolo mode: every tool call runs without asking. Deny rules still apply.",
        );
      }
      return allowed;
    }

    // 5. Allow rules (bash) or a session-wide tool grant (edits).
    if (command !== undefined) {
      const verdict = evaluateBash(command, this.allowRules(), this.deny);
      if (verdict.kind === "allow") return allowed;
    } else if (this.sessionTools.has(tool.name)) {
      return allowed;
    }

    // 6. auto-edit: file edits pass, bash still asks.
    if (this.opts.mode === "auto-edit" && EDIT_TOOLS.has(tool.name)) {
      return allowed;
    }

    // 7. Ask.
    return this.prompt(tool, input, ctx, command);
  }

  private allowRules(): Rule[] {
    return [...this.configAllow, ...this.sessionAllow];
  }

  private async prompt(
    tool: ErasedTool,
    input: unknown,
    ctx: ToolContext,
    command: string | undefined,
  ): Promise<PermissionDecision> {
    const request: PermissionRequest = {
      tool,
      title: tool.summarize(input),
      ...(command !== undefined ? { command } : {}),
    };
    const preview = tool.preview(input, ctx);
    if (preview) request.preview = preview;

    const suggestion = command !== undefined ? suggestRule(command) : undefined;
    if (suggestion) request.suggestion = suggestion;

    const answer = await this.opts.ask(request);

    switch (answer.kind) {
      case "no":
        return denied(answer.reason ?? "the user declined this action");

      case "once":
        return allowed;

      case "session":
      case "persist": {
        this.grant(tool, suggestion);
        if (answer.kind === "persist") {
          const grant =
            tool.name === "bash"
              ? suggestion
                ? ({ kind: "bash", rule: suggestion } as const)
                : undefined
              : ({ kind: "tool", name: tool.name } as const);

          if (!grant) {
            // Nothing narrow enough to save; the session grant still stands.
            this.opts.notify?.(
              "this command is too broad to save as a rule; allowed for this session only",
            );
          } else {
            const label = grant.kind === "bash" ? grant.rule : grant.name;
            const written = persistAllow(this.opts.projectDir, grant);
            this.opts.notify?.(
              written
                ? `saved "${label}" to .rocky/settings.json`
                : `could not write .rocky/settings.json; "${label}" allowed for this session only`,
            );
          }
        }
        return allowed;
      }
    }
  }

  /**
   * A bash "always" grants the suggested command prefix. When no narrow rule
   * can be suggested — a compound line, or a dynamic one — we grant nothing
   * and the next identical call asks again. Blessing `bash` wholesale because
   * the user approved one pipeline would be a footgun.
   */
  private grant(tool: ErasedTool, suggestion: string | undefined): void {
    if (tool.name === "bash") {
      if (suggestion) this.sessionAllow.push(...parseRules([suggestion]));
      return;
    }
    this.sessionTools.add(tool.name);
  }
}

/** bash input is validated downstream; here we only need the command text. */
function commandOf(input: unknown): string {
  if (typeof input === "object" && input !== null && "command" in input) {
    const c = (input as { command: unknown }).command;
    if (typeof c === "string") return c;
  }
  return "";
}
