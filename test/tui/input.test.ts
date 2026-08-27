import { describe, expect, test } from "bun:test";
import {
  completeSlash,
  HISTORY_LIMIT,
  parseHistory,
  serializeHistory,
  SLASH_COMMANDS,
  splitTypeAhead,
  unknownCommand,
} from "../../src/tui/input.ts";

describe("completeSlash", () => {
  test("a partial command completes to its full names", () => {
    const [hits, base] = completeSlash("/p");
    expect(hits).toEqual(["/permissions", "/plan"]);
    expect(base).toBe("/p");
  });

  test("a bare slash offers everything", () => {
    const [hits] = completeSlash("/");
    // Every advertised command completes, plus the /quit alias.
    expect(hits.length).toBe(SLASH_COMMANDS.length + 1);
    for (const c of SLASH_COMMANDS) expect(hits).toContain(c.name);
  });

  test("prose never completes — Tab must not mangle a sentence", () => {
    expect(completeSlash("fix the bug")[0]).toEqual([]);
    expect(completeSlash("")[0]).toEqual([]);
  });

  test("arguments never complete: they are paths and ids, not commands", () => {
    expect(completeSlash("/model qw")[0]).toEqual([]);
    expect(completeSlash("/expand ")[0]).toEqual([]);
  });

  test("no match returns empty, leaving the line alone", () => {
    expect(completeSlash("/zzz")[0]).toEqual([]);
  });
});

describe("unknownCommand", () => {
  test("a typo'd command is caught before it wastes a model round-trip", () => {
    expect(unknownCommand("/cmpact")).toBe("/cmpact");
    expect(unknownCommand("/hlep now")).toBe("/hlep");
  });

  test("every real command and alias passes", () => {
    for (const c of SLASH_COMMANDS) expect(unknownCommand(c.name)).toBeUndefined();
    expect(unknownCommand("/quit")).toBeUndefined();
    expect(unknownCommand("/model qwen3:8b")).toBeUndefined();
  });

  test("prose and paths pass through to the model", () => {
    expect(unknownCommand("fix the bug")).toBeUndefined();
    // A path has a second slash and is not a command shape at all.
    expect(unknownCommand("/etc/hosts is broken")).toBeUndefined();
    expect(unknownCommand("what does / mean in regex?")).toBeUndefined();
  });
});

describe("splitTypeAhead", () => {
  test("completed lines queue; the unfinished tail is the prefill", () => {
    expect(splitTypeAhead("run the tests\nthen commit")).toEqual({
      lines: ["run the tests"],
      partial: "then commit",
    });
  });

  test("Enter arrives as \\r in raw mode and still ends a line", () => {
    expect(splitTypeAhead("one\rtwo\r")).toEqual({ lines: ["one", "two"], partial: "" });
  });

  test("blank lines are dropped — stray Enters are not prompts", () => {
    expect(splitTypeAhead("\r\r  \rreal\r")).toEqual({ lines: ["real"], partial: "" });
  });

  test("backspace honors the user's own corrections", () => {
    expect(splitTypeAhead("teh\x7f\x7fhe fix").partial).toBe("the fix");
  });

  test("arrow keys and function keys vanish instead of becoming text", () => {
    // Up, Left, Delete, F1 — all escape sequences a terminal sends in raw mode.
    const raw = "\x1b[Aok\x1b[D\x1b[3~\x1bOP fine";
    expect(splitTypeAhead(raw)).toEqual({ lines: [], partial: "ok fine" });
  });

  test("control bytes are dropped, tabs survive", () => {
    expect(splitTypeAhead("a\x00\x01b\tc").partial).toBe("ab\tc");
  });

  test("nothing typed is nothing queued", () => {
    expect(splitTypeAhead("")).toEqual({ lines: [], partial: "" });
  });
});

describe("history round-trip", () => {
  test("file is oldest-first; readline wants newest-first", () => {
    expect(parseHistory("first\nsecond\nthird\n")).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  test("serialize inverts parse exactly", () => {
    const readlineOrder = ["newest", "older", "oldest"];
    expect(parseHistory(serializeHistory(readlineOrder))).toEqual(readlineOrder);
  });

  test("blank lines never survive in either direction", () => {
    expect(parseHistory("a\n\n  \nb\n")).toEqual(["b", "a"]);
    expect(serializeHistory(["a", "", "b"])).toBe("b\na\n");
  });

  test("both directions cap at the limit, keeping the newest", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 50 }, (_, i) => `cmd ${i}`);
    // File: oldest first, so the newest are at the end and must be the keepers.
    const parsed = parseHistory(many.join("\n"));
    expect(parsed).toHaveLength(HISTORY_LIMIT);
    expect(parsed[0]).toBe(`cmd ${HISTORY_LIMIT + 49}`);
    // readline: newest first, so the keepers are at the front.
    const serialized = serializeHistory([...many].reverse());
    const lines = serialized.trim().split("\n");
    expect(lines).toHaveLength(HISTORY_LIMIT);
    expect(lines.at(-1)).toBe(`cmd ${HISTORY_LIMIT + 49}`);
  });

  test("an empty history is an empty file, not a stray newline", () => {
    expect(serializeHistory([])).toBe("");
    expect(parseHistory("")).toEqual([]);
  });
});
