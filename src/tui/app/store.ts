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

/**
 * One row in a picker. `hint` is the dimmed second column; `disabled` rows are
 * shown but refuse selection — that is how the ~26 catalog providers Rocky
 * cannot drive stay visible instead of quietly vanishing from the list.
 */
export type PickerItem = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Shown instead of selecting, when `disabled`. */
  disabledReason?: string;
};

export type PermissionDialogRequest = {
  kind: "permission";
  request: PermissionRequest;
  resolve: (answer: Answer) => void;
};

export type SelectDialogRequest = {
  kind: "select";
  title: string;
  placeholder: string;
  items: PickerItem[];
  /** `undefined` means the user pressed Esc. */
  resolve: (value: string | undefined) => void;
};

/**
 * A single-line field. `masked` renders bullets and keeps the value out of
 * every signal — the same component serves an API key and a model id, because
 * the only difference between them is whether the characters may be drawn.
 */
export type PromptDialogRequest = {
  kind: "prompt";
  title: string;
  hint: string;
  masked: boolean;
  placeholder?: string;
  /** `undefined` is Esc; `""` is Enter on an empty field, meaning "skip". */
  resolve: (value: string | undefined) => void;
};

export type DialogRequest =
  | PermissionDialogRequest
  | SelectDialogRequest
  | PromptDialogRequest;

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
          kind: "permission",
          request,
          resolve: (answer) => {
            setDialog(null);
            resolve(answer);
          },
        });
      });
    },

    /**
     * A filterable list. Resolves with the chosen `value`, or undefined on Esc.
     * Same suspend-on-a-promise shape as askPermission, so /connect reads as
     * straight-line code despite the footer swapping components underneath.
     */
    askSelect(opts: {
      title: string;
      placeholder: string;
      items: PickerItem[];
    }): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        setDialog({
          kind: "select",
          ...opts,
          resolve: (value) => {
            setDialog(null);
            resolve(value);
          },
        });
      });
    },

    /** A single-line field; `masked` hides what is typed. See PromptDialog. */
    askPrompt(opts: {
      title: string;
      hint: string;
      masked: boolean;
      placeholder?: string;
    }): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        setDialog({
          kind: "prompt",
          ...opts,
          resolve: (value) => {
            setDialog(null);
            resolve(value);
          },
        });
      });
    },
  };
}

export type FooterStore = ReturnType<typeof createFooterStore>;
