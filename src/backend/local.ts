import { runTurn } from "../core/loop.ts";
import type { LoopEvent } from "../core/loop.ts";
import type { Session } from "../core/session.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { AgentBackend, BackendStatus, BackendTurnOptions } from "./types.ts";

export class LocalBackend implements AgentBackend {
  readonly kind = "local" as const;
  readonly displayName = "Local";
  private activeController: AbortController | undefined;

  constructor(
    readonly session: Session,
    private readonly registry: ToolRegistry,
  ) {}

  async *turn(prompt: string, options: BackendTurnOptions): AsyncGenerator<LoopEvent, void, undefined> {
    const controller = new AbortController();
    this.activeController = controller;
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      yield* runTurn(
        this.session,
        prompt,
        {
          registry: this.registry,
          ...(options.localApprove ? { approve: options.localApprove } : {}),
          ...(options.extraSystem ? { extraSystem: options.extraSystem } : {}),
        },
        controller.signal,
      );
    } finally {
      options.signal.removeEventListener("abort", abort);
      this.activeController = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.activeController?.abort();
  }

  status(): BackendStatus {
    return {
      kind: "local",
      connection: "ready",
      sessionId: this.session.id,
      sandbox: "unavailable",
      phase: "idle",
    };
  }
}
