import { describe, expect, test } from "bun:test";
import {
  ghostSuggestion,
  historyDown,
  historyStart,
  historyUp,
  slashMatches,
} from "../../../src/tui/app/editor-logic.ts";

const history = ["latest prompt", "older prompt", "oldest"];

describe("history navigation", () => {
  test("up walks from newest to oldest and saves the draft", () => {
    let st = historyStart();
    const up1 = historyUp(history, st, "my draft")!;
    expect(up1.text).toBe("latest prompt");
    expect(up1.state.draft).toBe("my draft");
    st = up1.state;
    const up2 = historyUp(history, st, up1.text)!;
    expect(up2.text).toBe("older prompt");
    // The draft saved on first departure survives later moves.
    expect(up2.state.draft).toBe("my draft");
  });

  test("up stops at the oldest entry", () => {
    let st = historyStart();
    for (let i = 0; i < history.length; i++) st = historyUp(history, st, "")!.state;
    expect(historyUp(history, st, "")).toBeUndefined();
  });

  test("down restores the saved draft at the bottom", () => {
    let st = historyStart();
    st = historyUp(history, st, "work in progress")!.state;
    const down = historyDown(history, st)!;
    expect(down.text).toBe("work in progress");
    expect(down.state.index).toBe(-1);
  });

  test("down while editing the draft does nothing", () => {
    expect(historyDown(history, historyStart())).toBeUndefined();
  });

  test("empty history never navigates", () => {
    expect(historyUp([], historyStart(), "x")).toBeUndefined();
  });
});

describe("ghostSuggestion", () => {
  test("completes from the most recent matching entry", () => {
    expect(ghostSuggestion(["deploy the app", "debug tests"], "de")).toBe("ploy the app");
  });

  test("no suggestion for empty, slash, multi-line, or exact input", () => {
    expect(ghostSuggestion(history, "")).toBe("");
    expect(ghostSuggestion(["/model x"], "/mo")).toBe("");
    expect(ghostSuggestion(["line one two"], "line\none")).toBe("");
    expect(ghostSuggestion(["exact"], "exact")).toBe("");
  });
});

describe("slashMatches", () => {
  test("prefix-filters the command table", () => {
    const names = slashMatches("/c").map((m) => m.name);
    expect(names).toContain("/cost");
    expect(names).toContain("/compact");
    expect(names).toContain("/clear");
    expect(names).not.toContain("/model");
  });

  test("closes once a space or newline appears, and for non-slash input", () => {
    expect(slashMatches("/model x")).toEqual([]);
    expect(slashMatches("/mo\n")).toEqual([]);
    expect(slashMatches("hello")).toEqual([]);
  });

  test("bare slash lists everything", () => {
    expect(slashMatches("/").length).toBeGreaterThan(5);
  });
});
