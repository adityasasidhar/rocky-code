/**
 * Boots the OpenTUI split-footer renderer and mounts the Solid footer app.
 * Plain TS on purpose: cli.ts imports this without touching JSX; the .tsx
 * files load only after the Solid transform is registered (see jsx.ts).
 */
import { format } from "node:util";
import type { CliRenderer } from "@opentui/core";
import type { FooterStore } from "./store.ts";
import { ensureSolidJsx } from "./jsx.ts";

export type FooterHandle = {
  renderer: CliRenderer;
  destroy: () => void;
};

export async function bootFooter(store: FooterStore): Promise<FooterHandle> {
  await ensureSolidJsx();
  const { createCliRenderer } = await import("@opentui/core");
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    targetFps: 30,
    gatherStats: false,
    autoFocus: false,
  });
  try {
    const { render } = await import("@opentui/solid");
    const { App } = await import("./app.tsx");
    await render(() => App({ store }), renderer);
  } catch (error) {
    renderer.destroy();
    throw error;
  }

  // Bun's console writes to fd 1 directly, bypassing process.stdout.write —
  // which is the hook capture-stdout replays into scrollback. Anything
  // console.log'd while the footer is up would land raw inside the footer
  // region and be overpainted, so the console routes through the intercepted
  // stream for the renderer's lifetime. stderr too: fd 2 is not captured, and
  // an interleaved raw write corrupts the frame just the same.
  const original = { log: console.log, warn: console.warn, error: console.error };
  const viaStdout =
    (): ((...args: unknown[]) => void) =>
    (...args) => {
      process.stdout.write(`${format(...args)}\n`);
    };
  console.log = viaStdout();
  console.warn = viaStdout();
  console.error = viaStdout();

  // Last-resort terminal restoration: destroy() on every exit path plus a
  // SIGHUP hook (terminal closed under us), mirroring what opencode ships.
  const onSighup = () => destroy();
  process.on("SIGHUP", onSighup);
  const destroy = () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    process.off("SIGHUP", onSighup);
    if (!renderer.isDestroyed) renderer.destroy();
  };
  return { renderer, destroy };
}
