import type { LoopDeps, LoopEvent } from "../core/loop.ts";

export interface BackendApprovalRequest {
  toolCallId: string;
  threadId: string;
  toolName: string;
  title: string;
  preview?: string;
}

export interface BackendTurnOptions {
  signal: AbortSignal;
  localApprove?: LoopDeps["approve"];
  extraSystem?: string[];
  approveAction?: (request: BackendApprovalRequest) => Promise<{ allow: boolean; reason?: string }>;
}

export interface BackendStatus {
  kind: "local" | "trueforge";
  connection: "offline" | "connecting" | "ready" | "error";
  sessionId?: string;
  activeTurnId?: string;
  sandbox: "unknown" | "creating" | "ready" | "unavailable";
  phase: "planning" | "delegated" | "validating" | "healing" | "awaiting_approval" | "idle";
}

export interface AgentBackend {
  readonly kind: "local" | "trueforge";
  readonly displayName: string;
  turn(prompt: string, options: BackendTurnOptions): AsyncGenerator<LoopEvent, void, undefined>;
  cancel(): Promise<void>;
  status(): BackendStatus;
  sessions?(): Promise<unknown>;
  replay?(): AsyncGenerator<LoopEvent, void, undefined>;
}
