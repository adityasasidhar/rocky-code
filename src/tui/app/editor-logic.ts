/**
 * The editor's stateful behaviors as pure functions, kept JSX-free so
 * bun:test exercises them without a renderer: history navigation with draft
 * save/restore (parity with the old editor), ghost-text suggestions, and the
 * slash-command popup's matching.
 */
import { SLASH_COMMANDS } from "../input.ts";

/** index -1 means "editing the live draft", 0.. index into history. */
export type HistState = { index: number; draft: string };

export const historyStart = (): HistState => ({ index: -1, draft: "" });

export function historyUp(
  history: readonly string[],
  state: HistState,
  current: string,
): { state: HistState; text: string } | undefined {
  const next = state.index + 1;
  if (next >= history.length) return undefined;
  return {
    // Leaving the draft saves it; moving within history keeps the saved one.
    state: { index: next, draft: state.index === -1 ? current : state.draft },
    text: history[next]!,
  };
}

export function historyDown(
  history: readonly string[],
  state: HistState,
): { state: HistState; text: string } | undefined {
  if (state.index === -1) return undefined;
  const next = state.index - 1;
  if (next === -1) return { state: { index: -1, draft: state.draft }, text: state.draft };
  return { state: { index: next, draft: state.draft }, text: history[next]! };
}

/**
 * The completion a Tab would accept: the most recent history entry that
 * extends what is typed. Slash commands have their own popup; multi-line
 * drafts never suggest (nobody retypes a paragraph from history).
 */
export function ghostSuggestion(history: readonly string[], current: string): string {
  if (!current || current.startsWith("/") || current.includes("\n")) return "";
  const hit = history.find((h) => h.startsWith(current) && h !== current);
  return hit ? hit.slice(current.length) : "";
}

export type SlashMatch = { name: string; usage: string; what: string };

/** Popup contents while typing a slash command ("/mo" → /model). */
export function slashMatches(current: string): SlashMatch[] {
  if (!current.startsWith("/") || /[\s\n]/.test(current)) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(current)).map((c) => ({
    name: c.name,
    usage: c.usage,
    what: c.what,
  }));
}
