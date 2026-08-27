/**
 * The one-line footer status row: activity on the left, session facts on the
 * right — the same parts the old cursor-save/restore StatusBar painted, but
 * as a plain component that OpenTUI keeps in place for free.
 */
import { Show, createSignal, onCleanup } from "solid-js";
import { compactNumber } from "../ansi.ts";
import type { FooterStore } from "./store.ts";
import type { FooterColors } from "./colors.ts";
import { Spin } from "./spinner.tsx";

const METER_WIDTH = 10;

function contextMeter(fraction: number): { bar: string; state: "ok" | "warn" | "high" } {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return { bar: "░".repeat(METER_WIDTH), state: "ok" };
  }
  const clamped = Math.min(1, fraction);
  const filled = Math.max(1, Math.round(clamped * METER_WIDTH));
  const bar = "█".repeat(filled) + "░".repeat(METER_WIDTH - filled);
  return { bar, state: clamped >= 0.8 ? "high" : clamped >= 0.6 ? "warn" : "ok" };
}

export function StatusRow(props: { store: FooterStore; colors: FooterColors }) {
  const { store, colors } = props;
  // Re-render the elapsed count once a second while a turn runs.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => {
    if (store.busy()) setNow(Date.now());
  }, 1000);
  onCleanup(() => clearInterval(tick));

  const elapsed = () => {
    const busy = store.busy();
    if (!busy) return "";
    return `${Math.max(0, Math.floor((now() - busy.since) / 1000))}s`;
  };

  // contextUsed is already a 0..1 fraction (see Session.contextUsed).
  const meterInfo = () => contextMeter(store.status().contextUsed);
  const meterColor = () => {
    const state = meterInfo().state;
    return state === "high" ? colors.error : state === "warn" ? colors.warning : colors.success;
  };

  const sep = () => <span style={{ fg: colors.muted }}> · </span>;

  return (
    <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" flexShrink={1}>
        <Show
          when={store.busy()}
          fallback={<span style={{ fg: colors.accent }}>●</span>}
        >
          {(busy: () => NonNullable<ReturnType<typeof store.busy>>) => (
            <>
              <Spin color={colors.warning} />
              <span style={{ fg: colors.text }}> {busy().label}… </span>
              <span style={{ fg: colors.muted }}>
                {elapsed()} · esc to interrupt
              </span>
            </>
          )}
        </Show>
      </text>
      <box flexGrow={1} />
      <text wrapMode="none">
        <span style={{ fg: colors.accent }}>{store.status().provider}</span>
        <Show when={store.status().backendConnection}>
          <span style={{ fg: colors.muted }}>:{store.status().backendConnection}</span>
        </Show>
        <Show when={store.status().backendSession}>
          <span style={{ fg: colors.muted }}> #{store.status().backendSession}</span>
        </Show>
        <Show when={store.status().sandbox}>
          {sep()}
          <span style={{ fg: colors.muted }}>sandbox {store.status().sandbox}</span>
        </Show>
        <Show when={store.status().phase && store.status().phase !== "idle"}>
          {sep()}
          <span style={{ fg: colors.warning }}>{store.status().phase}</span>
        </Show>
        <Show when={store.status().workers}>
          {sep()}
          <span style={{ fg: colors.muted }}>workers {store.status().workers}</span>
        </Show>
        {sep()}
        <span style={{ fg: colors.muted }}>{store.status().model}</span>
        {sep()}
        <span style={{ fg: meterColor() }}>{meterInfo().bar}</span>
        <span style={{ fg: colors.muted }}>
          {" "}
          {Math.round(store.status().contextUsed * 100)}%
        </span>
        {sep()}
        <span style={{ fg: colors.muted }}>{store.status().mode}</span>
        {sep()}
        <span style={{ fg: colors.muted }}>
          {compactNumber(store.status().tokensIn)}/{compactNumber(store.status().tokensOut)}
        </span>
        <Show when={store.status().costUsd > 0}>
          {sep()}
          <span style={{ fg: colors.muted }}>${store.status().costUsd.toFixed(4)}</span>
        </Show>
      </text>
    </box>
  );
}
