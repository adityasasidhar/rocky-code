/**
 * The two dialogs `/connect` and `/models` are built from: a filterable list,
 * and a masked field.
 *
 * Both follow PermissionDialog's contract — the dialog owns the keyboard while
 * it is up, and resolving is deferred a tick so the answering keypress finishes
 * dispatching before the editor remounts and takes focus.
 *
 * The list is hand-rolled rather than OpenTUI's <select>: filtering has to
 * rewrite the option set on every keystroke while keeping the highlight sane,
 * and a windowed <For> over a filtered array is both shorter and easier to
 * reason about than driving SelectRenderable's imperative index.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { PickerItem, PromptDialogRequest, SelectDialogRequest } from "./store.ts";
import type { FooterColors } from "./colors.ts";

/** Rows of the list shown at once; the rest scroll under the highlight. */
export const PICKER_VISIBLE_ROWS = 8;
/** Rows the prompt dialog occupies: border + field + two hint lines. */
export const PROMPT_DIALOG_ROWS = 6;

/**
 * Match strength, best first. Ranking rather than a plain boolean is what keeps
 * "M3" from selecting MiniMax-M2: both matched once, because the loose pass ran
 * over the hint text too and every model's price hint contains a "3".
 * Subsequence matching is now confined to the label and value, and anything it
 * finds sorts below a real substring hit.
 */
export const MatchRank = {
  Prefix: 0,
  Substring: 1,
  Hint: 2,
  Subsequence: 3,
  None: 4,
} as const;
export type MatchRank = (typeof MatchRank)[keyof typeof MatchRank];

const isSubsequence = (haystack: string, needle: string): boolean => {
  let index = 0;
  for (const char of needle) {
    if (char === " ") continue;
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
};

export function rank(item: PickerItem, query: string): MatchRank {
  if (query === "") return MatchRank.Prefix;
  const needle = query.toLowerCase();
  const label = item.label.toLowerCase();
  const value = item.value.toLowerCase();

  if (label.startsWith(needle)) return MatchRank.Prefix;
  if (label.includes(needle) || value.includes(needle)) return MatchRank.Substring;
  if ((item.hint ?? "").toLowerCase().includes(needle)) return MatchRank.Hint;
  if (isSubsequence(`${label} ${value}`, needle)) return MatchRank.Subsequence;
  return MatchRank.None;
}

export const matches = (item: PickerItem, query: string): boolean =>
  rank(item, query) !== MatchRank.None;

/** Matching rows, best match first. Ties keep their original order. */
export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  return items
    .map((item, index) => ({ item, index, score: rank(item, query) }))
    .filter((row) => row.score !== MatchRank.None)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((row) => row.item);
}

/** The slice of rows to draw so the highlight stays on screen. */
export function windowFor(
  total: number,
  selected: number,
  rows: number = PICKER_VISIBLE_ROWS,
): { start: number; end: number } {
  if (total <= rows) return { start: 0, end: total };
  const start = Math.min(Math.max(0, selected - Math.floor(rows / 2)), total - rows);
  return { start, end: start + rows };
}

export function SelectDialog(props: { dialog: SelectDialogRequest; colors: FooterColors }) {
  const { colors } = props;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);

  const shown = createMemo(() => filterItems(props.dialog.items, query()));
  const view = createMemo(() => windowFor(shown().length, selected()));
  const [notice, setNotice] = createSignal("");

  const clampTo = (next: number) => {
    const total = shown().length;
    if (total === 0) return 0;
    return (next + total) % total;
  };

  const finish = (value: string | undefined) =>
    queueMicrotask(() => props.dialog.resolve(value));

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      finish(undefined);
      return;
    }
    if (key.name === "up") {
      setSelected((s) => clampTo(s - 1));
      return;
    }
    if (key.name === "down") {
      setSelected((s) => clampTo(s + 1));
      return;
    }
    if (key.name === "pageup") {
      setSelected((s) => clampTo(s - PICKER_VISIBLE_ROWS));
      return;
    }
    if (key.name === "pagedown") {
      setSelected((s) => clampTo(s + PICKER_VISIBLE_ROWS));
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      const item = shown()[selected()];
      if (!item) return;
      // A disabled row explains itself rather than doing nothing.
      if (item.disabled) {
        setNotice(item.disabledReason ?? "not available");
        return;
      }
      finish(item.value);
      return;
    }
    if (key.name === "backspace") {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
      setNotice("");
      return;
    }
    // Printable characters type into the filter. `key.sequence` is the raw
    // byte(s); anything longer than one char is a control sequence, not typing.
    const char = key.sequence ?? "";
    if (char.length === 1 && char >= " " && char !== "\x7f") {
      setQuery((q) => q + char);
      setSelected(0);
      setNotice("");
    }
  });

  return (
    <box
      border
      borderColor={colors.accent}
      flexDirection="column"
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      title={props.dialog.title}
      titleAlignment="left"
    >
      <text wrapMode="none">
        <span style={{ fg: colors.muted }}>search: </span>
        <span style={{ fg: colors.text }}>{query() || props.dialog.placeholder}</span>
        <span style={{ fg: colors.muted }}>
          {shown().length === props.dialog.items.length
            ? `  (${props.dialog.items.length})`
            : `  (${shown().length}/${props.dialog.items.length})`}
        </span>
      </text>
      <Show
        when={shown().length > 0}
        fallback={<text fg={colors.muted}>no match — backspace to widen the search</text>}
      >
        <For each={shown().slice(view().start, view().end)}>
          {(item, index) => {
            const active = () => view().start + index() === selected();
            return (
              <text wrapMode="none">
                <span style={{ fg: active() ? colors.accent : colors.muted }}>
                  {active() ? "❯ " : "  "}
                </span>
                <span
                  style={{
                    fg: item.disabled
                      ? colors.muted
                      : active()
                        ? colors.text
                        : colors.muted,
                  }}
                >
                  {item.label}
                </span>
                <Show when={item.hint}>
                  <span style={{ fg: colors.muted }}> · {item.hint}</span>
                </Show>
              </text>
            );
          }}
        </For>
      </Show>
      <text fg={notice() ? colors.warning : colors.muted} wrapMode="none">
        {notice() || "type to filter · ↑↓ move · Enter select · Esc cancel"}
      </text>
    </box>
  );
}

export function PromptDialog(props: { dialog: PromptDialogRequest; colors: FooterColors }) {
  const { colors } = props;
  // When masked, the value lives in a plain local and only its *length* reaches
  // a signal — that is the whole reason this dialog exists, since typing a key
  // into the normal editor prints it as you type. Unmasked, the same field
  // serves as an ordinary text prompt.
  let secret = "";
  const [length, setLength] = createSignal(0);
  const [shown, setShown] = createSignal("");

  const finish = (value: string | undefined) =>
    queueMicrotask(() => {
      secret = "";
      setShown("");
      props.dialog.resolve(value);
    });

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      finish(undefined);
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      finish(secret);
      return;
    }
    if (key.name === "backspace") {
      secret = secret.slice(0, -1);
      setLength(secret.length);
      if (!props.dialog.masked) setShown(secret);
      return;
    }
    // Pasting arrives as one multi-character sequence; take it whole.
    const char = key.sequence ?? "";
    if (char.length >= 1 && !char.startsWith("\x1b") && char >= " ") {
      secret += char;
      setLength(secret.length);
      if (!props.dialog.masked) setShown(secret);
    }
  });

  return (
    <box
      border
      borderColor={colors.accent}
      flexDirection="column"
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      title={props.dialog.title}
      titleAlignment="left"
    >
      <text wrapMode="none">
        <span style={{ fg: colors.muted }}>{props.dialog.masked ? "key: " : "> "}</span>
        <span style={{ fg: colors.text }}>
          {props.dialog.masked ? "•".repeat(Math.min(length(), 48)) : shown()}
        </span>
        <span style={{ fg: colors.muted }}>
          {length() === 0 ? (props.dialog.placeholder ?? "") : ""}
        </span>
      </text>
      <text fg={colors.muted} wrapMode="none">
        {props.dialog.hint}
      </text>
      <text fg={colors.muted} wrapMode="none">
        Enter submits · Esc cancels
      </text>
    </box>
  );
}
