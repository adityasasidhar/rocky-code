import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema.ts";
import { createArchiver, type Archiver } from "./archive.ts";
import type { Message, Provider, TodoItem, Usage } from "./types.ts";
import { addUsage, emptyUsage, promptTokens } from "./types.ts";

export type SessionInit = {
  cwd: string;
  config: Config;
  provider: Provider;
  projectDir?: string;
  id?: string;
};

const newId = () =>
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

/**
 * Drop a `.gitignore` inside `.rocky/` so session logs, undo pre-images, and
 * archived tool output never show up in the user's `git status`. Ignoring
 * ourselves is strictly better than editing the user's .gitignore.
 */
function selfIgnore(rockyDir: string): void {
  const path = join(rockyDir, ".gitignore");
  try {
    if (!existsSync(path)) writeFileSync(path, "*\n", "utf8");
  } catch {
    // Best effort; a read-only .rocky must not stop the session from starting.
  }
}

/**
 * Mutable conversation state. The loop reads and appends; nothing else writes.
 */
export class Session {
  readonly id: string;
  readonly config: Config;
  readonly provider: Provider;
  readonly sessionDir: string;
  /** Where `.rocky/` lives. Sub-agent sessions must share it with their parent. */
  readonly projectDir: string;
  readonly startedAt = Date.now();

  cwd: string;
  model: string;
  messages: Message[] = [];
  /** The agent's visible plan; todo_write replaces it wholesale. */
  todos: TodoItem[] = [];
  /** Set when the configured post-edit check cannot run; checked once, not per batch. */
  checkBroken = false;
  readonly archive: Archiver;

  /** Cumulative across the session, for /cost. */
  totalUsage: Usage = emptyUsage();
  /** Usage of the most recent turn, for the per-turn readout. */
  lastTurnUsage: Usage = emptyUsage();
  /** Prompt size of the most recent request, for the context meter. */
  lastPromptTokens = 0;
  turns = 0;
  compactions = 0;
  /** Authoritative cost reported by a backend that owns provider billing. */
  private backendCostUsd: number | undefined;

  constructor(init: SessionInit) {
    this.id = init.id ?? newId();
    this.cwd = init.cwd;
    this.config = init.config;
    this.provider = init.provider;
    this.model = init.config.model;

    this.projectDir = init.projectDir ?? init.cwd;
    const rockyDir = join(this.projectDir, ".rocky");
    this.sessionDir = join(rockyDir, "session", this.id);
    mkdirSync(this.sessionDir, { recursive: true });
    selfIgnore(rockyDir);
    this.archive = createArchiver(this.sessionDir);
  }

  append(message: Message): void {
    if (message.content.length === 0) return;
    this.messages.push(message);
  }

  recordUsage(usage: Usage): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
    this.lastTurnUsage = usage;
    const p = promptTokens(usage);
    if (p > 0) this.lastPromptTokens = p;
  }

  recordBackendCost(costUsd: number): void {
    this.backendCostUsd = (this.backendCostUsd ?? 0) + costUsd;
  }

  /**
   * Roll a sub-agent's spend into this session's totals. Cost only — the
   * child's prompt size says nothing about *this* session's context meter.
   */
  absorbUsage(usage: Usage): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
  }

  /**
   * After compaction the prompt is much smaller, but no request has run yet to
   * measure it. Zeroing is honest: the meter reads "unknown until next turn"
   * rather than continuing to display the pre-compaction size, which would
   * immediately re-trigger compaction.
   */
  resetContextMeter(): void {
    this.lastPromptTokens = 0;
  }

  get contextWindow(): number {
    return this.provider.contextWindow(this.model);
  }

  /** 0..1 — drives the TUI meter and the auto-compaction trigger. */
  get contextUsed(): number {
    return this.lastPromptTokens / this.contextWindow;
  }

  /** True when the next request is likely to crowd the window. */
  get needsCompaction(): boolean {
    return this.contextUsed >= this.config.compactThreshold;
  }

  /** Cache writes bill at 1.25x input, reads at 0.1x. */
  get costUsd(): number {
    if (this.backendCostUsd !== undefined) return this.backendCostUsd;
    const { input, output } = this.provider.pricing(this.model);
    const u = this.totalUsage;
    return (
      u.inputTokens * input +
      u.cacheCreationInputTokens * input * 1.25 +
      u.cacheReadInputTokens * input * 0.1 +
      u.outputTokens * output
    );
  }
}
