/**
 * The permission dialog. Replaces ttyAsk's raw single-key stdin read: the
 * tool loop suspends on a promise while this component owns the footer, and
 * a keypress (y/n/a/p, Esc, or arrows+Enter) resolves it.
 */
import { For, Show, createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { Answer } from "../../permissions/engine.ts";
import type { DialogRequest } from "./store.ts";
import type { FooterColors } from "./colors.ts";

export const DIALOG_PREVIEW_LINES = 10;

type Option = { key: string; label: string; answer: Answer };

function options(dialog: DialogRequest): Option[] {
  const request = dialog.request;
  const oneShot: Option[] = [
    { key: "y", label: "yes, once", answer: { kind: "once" } },
    { key: "n", label: "no", answer: { kind: "no" } },
  ];
  if (request.onceOnly) return oneShot;
  const always = request.command
    ? request.suggestion
      ? `always allow ${request.suggestion} this session`
      : "always allow this tool this session"
    : `always allow ${request.tool.name} this session`;
  return [
    ...oneShot,
    { key: "a", label: always, answer: { kind: "session" } },
    { key: "p", label: "always, and save to .rocky/settings.json", answer: { kind: "persist" } },
  ];
}

export function PermissionDialog(props: { dialog: DialogRequest; colors: FooterColors }) {
  const { colors } = props;
  const [selected, setSelected] = createSignal(0);
  const opts = () => options(props.dialog);

  const previewLines = () => {
    const request = props.dialog.request;
    const headline = request.command ?? request.title;
    if (!request.preview || request.preview.trim() === headline.trim()) return [];
    return request.preview.split("\n");
  };
  const shownPreview = () => previewLines().slice(0, DIALOG_PREVIEW_LINES);
  const hiddenCount = () => Math.max(0, previewLines().length - DIALOG_PREVIEW_LINES);

  const lineColor = (line: string): string => {
    if (line.startsWith("+")) return colors.success;
    if (line.startsWith("-")) return colors.error;
    return colors.muted;
  };

  // Resolving swaps the dialog back out for the editor. Deferred a tick so
  // the key event that answered the dialog finishes dispatching before the
  // editor remounts and takes focus — otherwise that same key lands in it.
  const resolve = (answer: Answer) => queueMicrotask(() => props.dialog.resolve(answer));

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      resolve({ kind: "no" });
      return;
    }
    if (key.name === "up") {
      setSelected((s) => (s + opts().length - 1) % opts().length);
      return;
    }
    if (key.name === "down") {
      setSelected((s) => (s + 1) % opts().length);
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      resolve(opts()[selected()]!.answer);
      return;
    }
    const option = opts().find((value) => value.key === key.name);
    if (option) resolve(option.answer);
  });

  return (
    <box
      border
      borderColor={colors.warning}
      flexDirection="column"
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      title="Permission required"
      titleAlignment="left"
    >
      <text fg={colors.text} wrapMode="none">
        <span style={{ fg: colors.warning }}>{props.dialog.request.tool.name}</span>
        <span style={{ fg: colors.muted }}> · </span>
        {props.dialog.request.command ?? props.dialog.request.title}
      </text>
      <Show when={shownPreview().length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={shownPreview()}>
            {(line) => (
              <text fg={lineColor(line)} wrapMode="none">
                {line || " "}
              </text>
            )}
          </For>
          <Show when={hiddenCount() > 0}>
            <text fg={colors.muted}>… {hiddenCount()} more lines</text>
          </Show>
        </box>
      </Show>
      <For each={opts()}>
        {(option, index) => (
          <text wrapMode="none">
            <span style={{ fg: index() === selected() ? colors.accent : colors.muted }}>
              {index() === selected() ? "❯ " : "  "}
            </span>
            <span style={{ fg: colors.accent }}>{option.key}</span>
            <span style={{ fg: index() === selected() ? colors.text : colors.muted }}> {option.label}</span>
          </text>
        )}
      </For>
    </box>
  );
}
