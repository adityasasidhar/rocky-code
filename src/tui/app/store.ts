/**
 * The bridge between the REPL loop (plain async code) and the Solid footer
 * app (reactive components). The REPL writes signals; the app renders them and
 * fires the callbacks back. Deliberately JSX-free so cli.ts and tests can
 * import it without the Solid transform.
 */
import { createSignal } from "solid-js";
import type { Answer, PermissionRequest } from "../../permissions/engine.ts";

export type StatusInfo = {
  provider: string;
  model: string;
  contextUsed: number;
  contextWindow: number;
  mode: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  backendConnection?: string;
  backendSession?: string;
  workers?: string;
  sandbox?: string;
  phase?: string;
};

export type BusyInfo = {
  since: number;
  label: string;
};

export type DialogRequest = {
  request: PermissionRequest;
  resolve: (answer: Answer) => void;
};

export type FooterCallbacks = {
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onExit: () => void;
};

export function createFooterStore(initial: StatusInfo, callbacks: FooterCallbacks) {
  const [busy, setBusy] = createSignal<BusyInfo | null>(null);
  const [status, setStatus] = createSignal<StatusInfo>(initial);
  const [dialog, setDialog] = createSignal<DialogRequest | null>(null);
  const [queued, setQueued] = createSignal<readonly string[]>([]);
  const [history, setHistory] = createSignal<readonly string[]>([]);

  return {
    busy,
    setBusy,
    status,
    setStatus,
    dialog,
    queued,
    setQueued,
    history,
    setHistory,
    ...callbacks,
    /**
     * Show the permission dialog and resolve with the user's choice. The tool
     * loop is suspended on this promise; the footer swaps the editor for the
     * dialog until a key lands.
     */
    askPermission(request: PermissionRequest): Promise<Answer> {
      return new Promise<Answer>((resolve) => {
        setDialog({
          request,
          resolve: (answer) => {
            setDialog(null);
            resolve(answer);
          },
        });
      });
    },
  };
}

export type FooterStore = ReturnType<typeof createFooterStore>;
