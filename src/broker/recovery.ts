import type { WorkerExitClass, WorkerHealth, WorkerRecommendation } from "./types.ts";

export function classifyFailure(message: string, exitCode?: number): WorkerExitClass {
  const text = message.toLowerCase();
  if (/unauthori[sz]ed|authentication|invalid api key|401|credential/.test(text)) return "authentication";
  if (/not found|no such image|cannot connect to the docker daemon|unavailable/.test(text)) return "unavailable";
  if (/timed? out|timeout|deadline/.test(text) || exitCode === 124) return "timeout";
  if (/invalid.*(?:json|event)|truncated.*(?:json|stream)/.test(text)) return "invalid_stream";
  if (/invalid patch|does not apply|patch failed/.test(text)) return "invalid_patch";
  if (/test.*failed|validation.*failed/.test(text)) return "validation_failed";
  if (/config|missing model|unknown option/.test(text)) return "configuration";
  return "crash";
}

export function recommendWorkers(
  workers: readonly WorkerHealth[],
  capabilities: readonly string[] = [],
): WorkerRecommendation[] {
  return workers
    .map((worker) => {
      const reasons: string[] = [];
      let score = 0;
      if (worker.enabled) score += 20;
      else reasons.push("disabled");
      if (worker.available) score += 25;
      else reasons.push(worker.reason ?? "image unavailable");
      if (worker.authenticated) score += 15;
      else reasons.push("credentials unavailable");
      const matches = capabilities.filter((tag) => worker.capabilities.includes(tag));
      score += matches.length * 10;
      if (matches.length > 0) reasons.push(`matches ${matches.join(", ")}`);
      score += Math.round(worker.recentSuccessRate * 20);
      score -= worker.costTier * 3;
      reasons.push(`cost tier ${worker.costTier}`);
      if (worker.averageLatencyMs !== undefined) {
        score -= Math.min(10, Math.round(worker.averageLatencyMs / 60_000));
        reasons.push(`recent latency ${Math.round(worker.averageLatencyMs / 1_000)}s`);
      }
      if (worker.running >= worker.concurrency) {
        score -= 50;
        reasons.push("at concurrency limit");
      }
      return { ...worker, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export class RecoveryBudget {
  private attempts = 0;
  constructor(readonly limit = 3) {}

  consume(): number {
    if (this.attempts >= this.limit) throw new Error(`recovery attempt limit reached (${this.limit})`);
    this.attempts++;
    return this.attempts;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.attempts);
  }
}

export function assertRecoveryAllowed(taskId: string, attempts: number, limit: number): void {
  if (attempts >= limit) {
    throw new Error(`recovery attempt limit reached for ${taskId} (${limit})`);
  }
}
