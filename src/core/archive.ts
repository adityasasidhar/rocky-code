import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes a full tool output to disk and returns its path, or undefined. */
export type Archiver = (toolName: string, content: string) => string | undefined;

/**
 * Per-session archiver. The counter lives here rather than at module scope so
 * two sessions in one process (sub-agents, tests) cannot collide on filenames.
 */
export function createArchiver(sessionDir: string): Archiver {
  let counter = 0;
  const dir = join(sessionDir, "outputs");

  return (toolName, content) => {
    // Archiving is a courtesy: a failure here must never fail the tool call.
    try {
      mkdirSync(dir, { recursive: true });
      const name = `${String(++counter).padStart(4, "0")}-${toolName}.txt`;
      const path = join(dir, name);
      writeFileSync(path, content, "utf8");
      return path;
    } catch {
      return undefined;
    }
  };
}

/** An archiver that keeps nothing. For tests and read-only contexts. */
export const nullArchiver: Archiver = () => undefined;
