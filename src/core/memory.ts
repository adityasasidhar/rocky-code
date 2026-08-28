import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Project memory: standing instructions the project keeps for its agents.
 *
 * `ROCKY.md` wins because it can carry Rocky-specific guidance; `AGENTS.md` is
 * the ecosystem convention and makes Rocky useful in repos already set up for
 * other agents. Exactly one file is loaded — merging two overlapping
 * instruction sets invites contradictions no model resolves well.
 */
export const MEMORY_FILES = ["ROCKY.md", "AGENTS.md"] as const;

/**
 * Memory rides in the system prompt on every request, so an unbounded file
 * would tax every turn. Anything this long belongs in the repo as docs the
 * agent reads on demand.
 */
export const MAX_MEMORY_BYTES = 24 * 1024;

const WHITESPACE = /^\s$/u;

function trimBounds(text: string): { start: number; end: number } {
  let start = 0;
  while (start < text.length) {
    const codePoint = text.codePointAt(start);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (!WHITESPACE.test(character)) break;
    start += character.length;
  }

  let end = text.length;
  while (end > start) {
    let characterStart = end - 1;
    const lastUnit = text.charCodeAt(characterStart);
    if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && characterStart > start) {
      const previousUnit = text.charCodeAt(characterStart - 1);
      if (previousUnit >= 0xd800 && previousUnit <= 0xdbff) characterStart--;
    }
    const character = text.slice(characterStart, end);
    if (!WHITESPACE.test(character)) break;
    end = characterStart;
  }
  return { start, end };
}

function takeUtf8(
  text: string,
  start: number,
  end: number,
  maxBytes: number,
): { value: string; truncated: boolean } {
  let bytes = 0;
  let cursor = start;
  while (cursor < end) {
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    cursor += character.length;
  }
  return { value: text.slice(start, cursor), truncated: cursor < end };
}

/**
 * Returns a system-prompt segment, or undefined when the project keeps none.
 *
 * A missing file is the normal case and returns quietly. Any *other* failure —
 * unreadable, a directory by that name — throws: the user wrote instructions
 * they expect the agent to follow, and silently proceeding without them is the
 * kind of failure nobody notices until the agent misbehaves.
 */
export function loadProjectMemory(projectDir: string): string | undefined {
  for (const name of MEMORY_FILES) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot read project memory ${name}: ${(e as Error).message}`);
    }

    const bounds = trimBounds(text);
    if (bounds.start === bounds.end) return undefined;

    const prefix = `${[
      `<project-memory source="${name}">`,
      "The project keeps these standing instructions for coding agents.",
      "Follow them. When they conflict with the user's request, the user wins.",
    ].join("\n")}\n\n`;
    const suffix = "\n</project-memory>";
    const wrapperBytes = Buffer.byteLength(`${prefix}${suffix}`, "utf8");
    const body = takeUtf8(
      text,
      bounds.start,
      bounds.end,
      Math.max(0, MAX_MEMORY_BYTES - wrapperBytes),
    );
    if (!body.truncated) return `${prefix}${body.value}${suffix}`;

    const notice = `\n… ${name} was truncated to keep project memory within ${MAX_MEMORY_BYTES} bytes; read the file for the rest.`;
    const contentBytes = Math.max(
      0,
      MAX_MEMORY_BYTES - Buffer.byteLength(`${prefix}${notice}${suffix}`, "utf8"),
    );
    const truncatedBody = takeUtf8(text, bounds.start, bounds.end, contentBytes);
    return `${prefix}${truncatedBody.value}${notice}${suffix}`;
  }
  return undefined;
}
