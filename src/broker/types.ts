import type { WorkerKind, WorkerProfile } from "../config/schema.ts";

export type WorkerEventType = "started" | "thinking" | "message" | "tool" | "completed" | "failed";

export interface WorkerEvent {
  type: WorkerEventType;
  at: string;
  text?: string;
  tool?: string;
  rawType?: string;
}

export type WorkerExitClass =
  | "success"
  | "authentication"
  | "configuration"
  | "unavailable"
  | "timeout"
  | "crash"
  | "invalid_stream"
  | "invalid_patch"
  | "validation_failed"
  | "cancelled";

export interface WorkerHealth {
  name: string;
  kind: WorkerKind;
  enabled: boolean;
  image: string;
  version: string;
  model?: string;
  capabilities: string[];
  available: boolean;
  authenticated: boolean;
  recentSuccessRate: number;
  averageLatencyMs?: number;
  costTier: number;
  running: number;
  concurrency: number;
  reason?: string;
}

export interface WorkerRecommendation extends WorkerHealth {
  score: number;
  reasons: string[];
}

export interface WorkerRun {
  id: string;
  taskId: string;
  worker: string;
  snapshotId: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  events: WorkerEvent[];
  /** Plain-text fallbacks indicate the pinned adapter no longer matches its CLI stream. */
  adapterFallbacks?: number;
  elapsedMs?: number;
  resourceUsage?: {
    elapsedMs: number;
    cpuPercent?: string;
    memoryUsage?: string;
    pids?: number;
  };
  patch?: string;
  summary?: string;
  verificationClaim?: string;
  logs?: string;
  exitClass?: WorkerExitClass;
  exitCode?: number;
}

export interface AdapterInvocation {
  command: string[];
  env: Record<string, string>;
}

export interface WorkerAdapter {
  kind: WorkerKind;
  invocation(profile: WorkerProfile, prompt: string): AdapterInvocation;
  parseLine(line: string): WorkerEvent | undefined;
}
