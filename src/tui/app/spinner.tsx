import { createSignal, onCleanup } from "solid-js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The same braille spinner the old ANSI renderer used, as a component.
 * A span, not a text: it lives inside the status row's text element, and
 * text nodes only accept spans and strings as children.
 */
export function Spin(props: { color: string }) {
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
  onCleanup(() => clearInterval(timer));
  return <span style={{ fg: props.color }}>{FRAMES[frame()]}</span>;
}
