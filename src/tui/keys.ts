/**
 * Watches the terminal for interrupt keys while a turn is running.
 *
 * Two things make this less trivial than it looks.
 *
 * Raw mode suppresses signal generation, so once we take the keyboard, Ctrl-C
 * no longer raises SIGINT. If this watcher did not handle `0x03` itself, taking
 * over stdin to add Esc would silently break Ctrl-C. It handles both.
 *
 * A permission prompt reads a single keypress straight from stdin. If this
 * watcher were still attached, both would consume the key. Hence `pause()` and
 * `resume()`: the caller hands the keyboard back for the duration of a prompt.
 */

export type Key = "escape" | "ctrl-c";

export type KeyWatcher = {
  /** Release the keyboard, e.g. while a permission prompt is up. */
  pause(): void;
  resume(): void;
  /**
   * Everything typed while watching that was not an interrupt key, raw.
   * Returned once and cleared: the caller turns it into queued prompts
   * instead of letting the turn eat the user's typing.
   */
  drain(): string;
  /** Restore the terminal. Safe to call twice. */
  dispose(): void;
};

/**
 * Classify a raw keypress buffer.
 *
 * A lone `0x1b` is Esc. Arrow keys and other escape sequences also begin with
 * `0x1b` but arrive in the same read as their suffix (`\x1b[A`), so length is
 * enough to tell them apart without a timer.
 */
export function classifyKey(buf: Uint8Array): Key | undefined {
  if (buf.length === 1 && buf[0] === 0x1b) return "escape";
  if (buf.includes(0x03)) return "ctrl-c";
  return undefined;
}

const NOOP_WATCHER: KeyWatcher = {
  pause: () => {},
  resume: () => {},
  drain: () => "",
  dispose: () => {},
};

export function watchKeys(opts: {
  onEscape: () => void;
  onCtrlC: () => void;
  stdin?: NodeJS.ReadStream;
}): KeyWatcher {
  const stdin = opts.stdin ?? process.stdin;
  // Piped or redirected input has no keyboard to watch.
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return NOOP_WATCHER;

  let active = false;
  const typed: Buffer[] = [];
  // Readline sets raw mode once when it takes a terminal and assumes it keeps
  // it. If we found the tty raw, dispose must leave it raw — handing back
  // cooked mode put the kernel's echo on top of readline's, and every line
  // typed after the first turn printed twice. Found live, of course.
  const wasRaw = stdin.isRaw === true;

  // Pausing readline is not enough: resuming the stream for our own listener
  // starts flow for every listener, and readline's keypress pump echoes what
  // it hears even with no question pending. Take the other listeners off the
  // stream for the watcher's whole lifetime and hand them back at dispose.
  // (Also found live: mid-turn typing flickered through the spinner line.)
  const foreign = stdin.rawListeners("data") as ((chunk: Buffer) => void)[];
  for (const fn of foreign) stdin.off("data", fn);

  const onData = (chunk: Buffer): void => {
    const key = classifyKey(chunk);
    if (key === "escape") opts.onEscape();
    else if (key === "ctrl-c") opts.onCtrlC();
    // Not an interrupt: the user is typing ahead. Raw mode means these bytes
    // never reach readline, so unless we keep them the turn eats the typing.
    else typed.push(chunk);
  };

  const resume = (): void => {
    if (active) return;
    active = true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  };

  const pause = (): void => {
    if (!active) return;
    active = false;
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
  };

  const drain = (): string => {
    const raw = Buffer.concat(typed).toString("utf8");
    typed.length = 0;
    return raw;
  };

  let disposed = false;
  const dispose = (): void => {
    pause();
    if (disposed) return;
    disposed = true;
    if (wasRaw) stdin.setRawMode(true);
    for (const fn of foreign) stdin.on("data", fn);
  };

  resume();
  return { pause, resume, drain, dispose };
}
