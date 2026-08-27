/**
 * The prompt editor: a bordered OpenTUI textarea that replaces the 400-line
 * hand-rolled raw-mode editor. Enter submits, Shift+Enter (kitty terminals)
 * or Ctrl+J (everywhere) inserts a newline. It stays mounted and focused
 * during turns — typing mid-turn queues naturally.
 *
 * On top of the textarea: history navigation with draft save/restore, a
 * slash-command popup, and ghost-text suggestions from history (Tab accepts).
 * The decisions live in editor-logic.ts; this file only wires keys to them.
 */
import { For, Show, createEffect, createSignal, onMount } from "solid-js";
import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import type { FooterStore } from "./store.ts";
import type { FooterColors } from "./colors.ts";
import {
  ghostSuggestion,
  historyDown,
  historyStart,
  historyUp,
  slashMatches,
  type HistState,
} from "./editor-logic.ts";

/** Imperative handle the root app uses for Ctrl-C clear / Ctrl-D exit checks. */
export type EditorApi = {
  text: () => string;
  clear: () => void;
  focus: () => void;
};

const SUBMIT_BINDINGS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
] as const;

export function PromptEditor(props: {
  store: FooterStore;
  colors: FooterColors;
  glyph: string;
  onApi: (api: EditorApi) => void;
  /** Rows this component occupies, so the app can size the footer. */
  onFootprint: (rows: number) => void;
}) {
  const { store, colors } = props;
  let input: TextareaRenderable | undefined;
  let hist: HistState = historyStart();
  /** True while setText comes from us, not the user's keys. */
  let programmatic = false;
  const [text, setText] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const matches = () => slashMatches(text());
  const ghost = () => ghostSuggestion(store.history(), text());

  const put = (value: string) => {
    if (!input) return;
    programmatic = true;
    input.setText(value);
    input.cursorOffset = value.length;
    programmatic = false;
    setText(value);
  };

  onMount(() => input?.focus());

  // Editor rows + border + popup + ghost line, reported as they change.
  createEffect(() => {
    const rows = Math.min(text().split("\n").length, 8) + 2;
    const popup = Math.min(matches().length, 6);
    props.onFootprint(rows + popup + (ghost() ? 1 : 0));
  });

  const submit = (value?: string) => {
    if (!input) return;
    const out = value ?? input.plainText;
    if (!out.trim()) return;
    put("");
    hist = historyStart();
    setSelected(0);
    store.onSubmit(out);
  };

  const onKeyDown = (key: KeyEvent) => {
    if (!input || key.eventType === "release") return;
    const popup = matches();

    if (popup.length > 0) {
      if (key.name === "up") {
        setSelected((s) => (s + popup.length - 1) % popup.length);
        key.preventDefault();
        return;
      }
      if (key.name === "down") {
        setSelected((s) => (s + 1) % popup.length);
        key.preventDefault();
        return;
      }
      if (key.name === "tab") {
        put(popup[Math.min(selected(), popup.length - 1)]!.name);
        key.preventDefault();
        return;
      }
      if (key.name === "return" && !key.shift && popup.length > 0) {
        // Enter runs the selected command, completed or not.
        const chosen = popup[Math.min(selected(), popup.length - 1)]!.name;
        if (chosen !== input.plainText) {
          submit(chosen);
          key.preventDefault();
        }
        return;
      }
      return;
    }

    if (key.name === "tab") {
      const suffix = ghost();
      if (suffix) put(input.plainText + suffix);
      key.preventDefault();
      return;
    }
    if (key.name === "up" && input.logicalCursor.row === 0) {
      const up = historyUp(store.history(), hist, input.plainText);
      if (up) {
        hist = up.state;
        put(up.text);
        key.preventDefault();
      }
      return;
    }
    if (key.name === "down") {
      const lastRow = input.plainText.split("\n").length - 1;
      if (input.logicalCursor.row === lastRow) {
        const down = historyDown(store.history(), hist);
        if (down) {
          hist = down.state;
          put(down.text);
          key.preventDefault();
        }
      }
      return;
    }
  };

  return (
    <box flexDirection="column" width="100%">
      <Show when={matches().length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={matches().slice(0, 6)}>
            {(match, index) => (
              <text wrapMode="none">
                <span
                  style={{ fg: index() === selected() ? colors.accent : colors.muted }}
                >
                  {index() === selected() ? "❯ " : "  "}
                  {match.usage.padEnd(14)}
                </span>
                <span style={{ fg: colors.muted }}>{match.what}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <box
        border
        borderColor={colors.border}
        flexDirection="row"
        width="100%"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={colors.accent} wrapMode="none">
          {props.glyph}{" "}
        </text>
        <textarea
          flexGrow={1}
          minHeight={1}
          maxHeight={8}
          placeholder="plan, build, fix… (/help for commands)"
          placeholderColor={colors.muted}
          textColor={colors.text}
          focusedTextColor={colors.text}
          keyBindings={[...SUBMIT_BINDINGS]}
          onSubmit={() => submit()}
          onKeyDown={onKeyDown}
          onContentChange={() => {
            if (!input) return;
            setText(input.plainText);
            setSelected(0);
            if (!programmatic) hist = { ...hist, index: -1 };
          }}
          ref={(r: TextareaRenderable) => {
            input = r;
            props.onApi({
              text: () => r.plainText,
              clear: () => put(""),
              focus: () => r.focus(),
            });
          }}
        />
      </box>
      <Show when={ghost()}>
        <text wrapMode="none" fg={colors.muted}>
          {"  ⇥ "}
          {text()}
          {ghost()}
        </text>
      </Show>
    </box>
  );
}
