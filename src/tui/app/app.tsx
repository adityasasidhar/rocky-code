/**
 * The footer app root. OpenTUI owns stdin for the whole session, so this one
 * keyboard handler replaces the old three-way raw-mode contention between the
 * editor, the mid-turn key watcher, and the permission prompt: keys route by
 * what is on screen (dialog open → dialog; otherwise editor + global chords).
 */
import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { useKeyboard, useRenderer } from "@opentui/solid";
import type { DialogRequest, FooterStore } from "./store.ts";
import { footerColors } from "./colors.ts";
import { PromptEditor, type EditorApi } from "./editor.tsx";
import { StatusRow } from "./statusbar.tsx";
import { PermissionDialog, DIALOG_PREVIEW_LINES } from "./dialogs.tsx";
import {
  PICKER_VISIBLE_ROWS,
  PROMPT_DIALOG_ROWS,
  PromptDialog,
  SelectDialog,
} from "./pickers.tsx";

const MAX_QUEUED_ROWS = 3;
const MAX_FOOTER_HEIGHT = 20;

export function App(props: { store: FooterStore }) {
  const store = props.store;
  const colors = footerColors();
  const renderer = useRenderer();
  const [editorRows, setEditorRows] = createSignal(3);
  let editor: EditorApi | undefined;
  let lastCtrlC = 0;

  const glyph = () => (store.status().mode === "plan" ? "plan ›" : "›");

  // The footer region grows with the editor (and with an open dialog) and
  // shrinks back; OpenTUI reflows the scrollback boundary for us.
  createEffect(() => {
    const dialog = store.dialog();
    const queuedRows = Math.min(store.queued().length, MAX_QUEUED_ROWS);
    let content: number;
    if (dialog?.kind === "permission") {
      const preview = dialog.request.preview?.split("\n") ?? [];
      const previewRows = Math.min(preview.length, DIALOG_PREVIEW_LINES + 1);
      content = 2 + 1 + previewRows + 4; // border + headline + preview + options
    } else if (dialog?.kind === "select") {
      // border + search line + rows (at least one, for the empty-state line) + footer hint
      content = 2 + 1 + Math.max(1, Math.min(dialog.items.length, PICKER_VISIBLE_ROWS)) + 1;
    } else if (dialog?.kind === "prompt") {
      content = PROMPT_DIALOG_ROWS;
    } else {
      content = editorRows(); // editor + border + popup + ghost, self-reported
    }
    renderer.footerHeight = Math.min(content + 1 + queuedRows, MAX_FOOTER_HEIGHT);
  });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (store.dialog()) return; // the dialog's own handler owns the keyboard

    if (key.name === "escape") {
      if (store.busy()) store.onInterrupt();
      return;
    }
    if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (now - lastCtrlC < 2000) {
        store.onExit();
        return;
      }
      lastCtrlC = now;
      if (store.busy()) {
        store.onInterrupt();
      } else if (editor && editor.text().length > 0) {
        editor.clear();
      } else {
        console.log("(Ctrl-C again to exit)");
      }
      return;
    }
    if (key.ctrl && key.name === "d") {
      if (!editor || editor.text().length === 0) store.onExit();
    }
  });

  return (
    <box flexDirection="column" width="100%">
      <Show when={store.queued().length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={store.queued().slice(0, MAX_QUEUED_ROWS)}>
            {(line) => (
              <text fg={colors.muted} wrapMode="none">
                ⧗ {line.split("\n")[0]}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show
        when={store.dialog()}
        fallback={
          <PromptEditor
            store={store}
            colors={colors}
            glyph={glyph()}
            onApi={(api) => {
              editor = api;
            }}
            onFootprint={setEditorRows}
          />
        }
      >
        {(dialog: () => NonNullable<ReturnType<typeof store.dialog>>) => (
          <Switch>
            <Match when={dialog().kind === "permission"}>
              <PermissionDialog
                dialog={dialog() as Extract<DialogRequest, { kind: "permission" }>}
                colors={colors}
              />
            </Match>
            <Match when={dialog().kind === "select"}>
              <SelectDialog
                dialog={dialog() as Extract<DialogRequest, { kind: "select" }>}
                colors={colors}
              />
            </Match>
            <Match when={dialog().kind === "prompt"}>
              <PromptDialog
                dialog={dialog() as Extract<DialogRequest, { kind: "prompt" }>}
                colors={colors}
              />
            </Match>
          </Switch>
        )}
      </Show>
      <StatusRow store={store} colors={colors} />
    </box>
  );
}
