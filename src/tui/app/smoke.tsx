/**
 * Hidden `rocky --tui-smoke` harness for the split-footer renderer.
 *
 * Exercises the two things the real footer app depends on and that no unit
 * test can prove: the native binary loads on this machine, and capture-stdout
 * replays partial-line SGR writes into scrollback without corruption. The
 * stream hammer mimics MarkdownStream's worst case — word-at-a-time writes
 * with color codes and no trailing newline until the paragraph ends.
 *
 * Keys: s = stream a burst, c = counter check runs on its own, q / Ctrl-C = quit.
 */
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const WORDS =
  `Rocky streams markdown a few characters at a time so answers appear the
moment the model produces them rather than a paragraph later.`.split(/\s+/);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Word-at-a-time partial-line writes, like MarkdownStream mid-paragraph. */
async function streamBurst(n: number): Promise<void> {
  process.stdout.write(`${BOLD}${CYAN}## burst ${n}${RESET}\n`);
  for (const [i, word] of WORDS.entries()) {
    const styled = i % 5 === 4 ? `${GREEN}${word}${RESET}` : word;
    process.stdout.write(styled + " ");
    await sleep(15);
  }
  process.stdout.write("\n");
  process.stdout.write(`${CYAN}\`\`\`${RESET}\n`);
  for (let i = 0; i < 3; i++) {
    process.stdout.write(`${GREEN}const line${i}${RESET} = `);
    await sleep(20);
    process.stdout.write(`${CYAN}"partial write ${i}"${RESET};\n`);
  }
  process.stdout.write(`${CYAN}\`\`\`${RESET}\n`);
}

function SmokeApp(props: { onQuit: () => void }) {
  const [seconds, setSeconds] = createSignal(0);
  const [bursts, setBursts] = createSignal(0);
  const [streaming, setStreaming] = createSignal(false);

  // A ticking signal proves the Solid JSX transform is active: with Bun's
  // default React-style transform this line would render once and freeze.
  const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
  onCleanup(() => clearInterval(timer));

  const burst = async () => {
    if (streaming()) return;
    setStreaming(true);
    await streamBurst(bursts() + 1);
    setBursts((b) => b + 1);
    setStreaming(false);
  };

  useKeyboard((key) => {
    if (key.name === "q" || (key.name === "c" && key.ctrl)) props.onQuit();
    if (key.name === "s") void burst();
  });

  return (
    <box border padding={1} flexDirection="column" title="rocky · opentui smoke">
      <text>
        reactivity check: <b>{String(seconds())}s</b> · bursts streamed:{" "}
        <b>{String(bursts())}</b>
        {streaming() ? " · streaming…" : ""}
      </text>
      <text fg="#888888">s stream a burst · q quit</text>
    </box>
  );
}

export async function runSmoke(): Promise<number> {
  let renderer: CliRenderer | undefined;
  const done = new Promise<void>((resolve) => {
    void (async () => {
      renderer = await createCliRenderer({
        screenMode: "split-footer",
        footerHeight: 5,
        externalOutputMode: "capture-stdout",
        exitOnCtrlC: false,
        useKittyKeyboard: {},
        targetFps: 30,
        gatherStats: false,
      });
      renderer.once("destroy", () => resolve());
      await render(() => <SmokeApp onQuit={() => renderer?.destroy()} />, renderer);
      console.log("smoke: renderer up — scrollback above, footer below");
      await streamBurst(0);
    })();
  });
  await done;
  console.log("smoke: clean exit, terminal restored");
  return 0;
}
