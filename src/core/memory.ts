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

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
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

    if (!text.trim()) continue;

    const prefix = `${[
      `<project-memory source="${name}">`,
      "The project keeps these standing instructions for coding agents.",
      "Follow them. When they conflict with the user's request, the user wins.",
    ].join("\n")}\n\n`;
    const suffix = "\n</project-memory>";
    const body = text.trim();
    const segment = `${prefix}${body}${suffix}`;
    if (Buffer.byteLength(segment, "utf8") <= MAX_MEMORY_BYTES) return segment;

    const notice = `\n… ${name} was truncated to keep project memory within ${MAX_MEMORY_BYTES} bytes; read the file for the rest.`;
    const contentBytes = Math.max(
      0,
      MAX_MEMORY_BYTES - Buffer.byteLength(`${prefix}${notice}${suffix}`, "utf8"),
    );
    return `${prefix}${truncateUtf8(body, contentBytes)}${notice}${suffix}`;
  }
  return undefined;
}
