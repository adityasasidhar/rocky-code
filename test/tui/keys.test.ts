import { describe, expect, test } from "bun:test";
import { classifyKey, watchKeys } from "../../src/tui/keys.ts";

const bytes = (...b: number[]) => Uint8Array.from(b);

describe("classifyKey", () => {
  test("a lone ESC is an interrupt", () => {
    expect(classifyKey(bytes(0x1b))).toBe("escape");
  });

  test("an escape sequence is not an interrupt", () => {
    // Arrow keys, Home/End, and friends all start with ESC. Treating them as an
    // interrupt would abort a turn whenever the user pressed Up.
    expect(classifyKey(bytes(0x1b, 0x5b, 0x41))).toBeUndefined(); // up arrow
    expect(classifyKey(bytes(0x1b, 0x5b, 0x44))).toBeUndefined(); // left arrow
    expect(classifyKey(bytes(0x1b, 0x4f, 0x50))).toBeUndefined(); // F1
  });

  test("Ctrl-C is recognized, since raw mode suppresses SIGINT", () => {
    expect(classifyKey(bytes(0x03))).toBe("ctrl-c");
    // Even when it arrives alongside other bytes in one read.
    expect(classifyKey(bytes(0x61, 0x03))).toBe("ctrl-c");
  });

  test("ordinary typing is ignored", () => {
    expect(classifyKey(bytes(0x61))).toBeUndefined();
    expect(classifyKey(bytes(0x0d))).toBeUndefined();
    expect(classifyKey(bytes())).toBeUndefined();
  });

  test("ESC takes precedence over a stray 0x03 later in the buffer", () => {
    // A lone ESC is length 1, so this can only be a sequence; it is not Esc.
    expect(classifyKey(bytes(0x1b, 0x03))).toBe("ctrl-c");
  });
});

describe("watchKeys", () => {
  test("is inert when stdin is not a terminal", () => {
    let fired = 0;
    const fakeStdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const watcher = watchKeys({
      onEscape: () => fired++,
      onCtrlC: () => fired++,
      stdin: fakeStdin,
    });
    // Piped input has no keyboard; the watcher must not try to take raw mode.
    watcher.pause();
    watcher.resume();
    expect(watcher.drain()).toBe("");
    watcher.dispose();
    expect(fired).toBe(0);
  });

  test("takes and restores raw mode, and routes keys", () => {
    const listeners: ((c: Buffer) => void)[] = [];
    const calls: string[] = [];
    const fakeStdin = {
      isTTY: true,
      setRawMode: (on: boolean) => calls.push(`raw:${on}`),
      resume: () => calls.push("resume"),
      pause: () => calls.push("pause"),
      rawListeners: () => [...listeners],
      on: (_e: string, fn: (c: Buffer) => void) => listeners.push(fn),
      off: (_e: string, fn: (c: Buffer) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    } as unknown as NodeJS.ReadStream;

    const seen: string[] = [];
    const watcher = watchKeys({
      onEscape: () => seen.push("escape"),
      onCtrlC: () => seen.push("ctrl-c"),
      stdin: fakeStdin,
    });

    expect(calls).toEqual(["raw:true", "resume"]);
    expect(listeners.length).toBe(1);

    listeners[0]!(Buffer.from([0x1b]));
    listeners[0]!(Buffer.from([0x03]));
    listeners[0]!(Buffer.from("hello"));
    expect(seen).toEqual(["escape", "ctrl-c"]);

    // Ordinary typing was kept, interrupt keys were not — and draining is
    // destructive, so the same typing cannot queue twice.
    expect(watcher.drain()).toBe("hello");
    expect(watcher.drain()).toBe("");

    // Pausing hands the keyboard back, so a permission prompt can read a key.
    watcher.pause();
    expect(listeners.length).toBe(0);
    expect(calls).toEqual(["raw:true", "resume", "raw:false", "pause"]);

    watcher.resume();
    expect(listeners.length).toBe(1);

    // Double-pause and double-dispose must not double-restore.
    watcher.dispose();
    watcher.dispose();
    expect(calls.filter((c) => c === "raw:false").length).toBe(2);
  });

  test("dispose hands a raw terminal back raw — readline still owns it", () => {
    // Between turns, readline holds the tty in raw mode and assumes it stays.
    // A dispose that left cooked mode re-enabled kernel echo, and every line
    // typed after the first turn appeared twice.
    const calls: string[] = [];
    const fakeStdin = {
      isTTY: true,
      isRaw: true,
      setRawMode: (on: boolean) => calls.push(`raw:${on}`),
      resume: () => {},
      pause: () => {},
      rawListeners: () => [],
      on: () => {},
      off: () => {},
    } as unknown as NodeJS.ReadStream;

    const watcher = watchKeys({ onEscape: () => {}, onCtrlC: () => {}, stdin: fakeStdin });
    watcher.dispose();
    expect(calls).toEqual(["raw:true", "raw:false", "raw:true"]);
  });

  test("readline's data listeners are off for the whole watch, back after", () => {
    // Readline shares the stream. If its keypress pump still hears mid-turn
    // typing it echoes the keys, so each queued prompt printed twice: once as
    // readline's stray echo, once as ours.
    const listeners: ((c: Buffer) => void)[] = [];
    const heard: string[] = [];
    const readlinePump = (c: Buffer) => heard.push(`rl:${c}`);
    listeners.push(readlinePump);

    const fakeStdin = {
      isTTY: true,
      isRaw: true,
      setRawMode: () => {},
      resume: () => {},
      pause: () => {},
      rawListeners: () => [...listeners],
      on: (_e: string, fn: (c: Buffer) => void) => listeners.push(fn),
      off: (_e: string, fn: (c: Buffer) => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    } as unknown as NodeJS.ReadStream;

    const watcher = watchKeys({ onEscape: () => {}, onCtrlC: () => {}, stdin: fakeStdin });
    // Only the watcher hears the keyboard now.
    expect(listeners).not.toContain(readlinePump);
    for (const fn of listeners) fn(Buffer.from("typed ahead"));
    expect(heard).toEqual([]);
    expect(watcher.drain()).toBe("typed ahead");

    // A permission prompt pauses the watcher; readline must stay detached
    // even then — the prompt reads its own key, and readline would echo it.
    watcher.pause();
    expect(listeners).not.toContain(readlinePump);
    watcher.resume();

    watcher.dispose();
    expect(listeners).toEqual([readlinePump]);
    // Disposing twice must not re-attach twice.
    watcher.dispose();
    expect(listeners).toEqual([readlinePump]);
  });
});
