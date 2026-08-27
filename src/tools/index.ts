import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit_file.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readFileTool } from "./read_file.ts";
import { taskTool } from "./task.ts";
import { todoTool } from "./todo.ts";
import { erase, type ErasedTool, type Tool } from "./types.ts";
import { writeFileTool } from "./write_file.ts";

/**
 * Ordered deliberately. The provider renders `tools` first in the cached
 * prefix, so this array must be byte-stable across requests or every cache
 * read misses. Never sort, filter, or rebuild it per-request.
 */
export const builtinTools: readonly ErasedTool[] = [
  erase(bashTool),
  erase(readFileTool),
  erase(writeFileTool),
  erase(editFileTool),
  erase(grepTool),
  erase(globTool),
  erase(taskTool),
  // Appended, never inserted: existing positions are cache-load-bearing.
  erase(todoTool),
];

/** Tools a read-only sub-agent or plan mode may use. */
export const readOnlyTools: readonly ErasedTool[] = builtinTools.filter(
  (t) => t.readOnly,
);

/** What a sub-agent gets: everything but `task` — no nested delegation. */
export const subAgentTools: readonly ErasedTool[] = builtinTools.filter(
  (t) => t.name !== "task",
);

export type ToolRegistry = ReadonlyMap<string, ErasedTool>;

export function makeRegistry(
  tools: readonly ErasedTool[] = builtinTools,
): ToolRegistry {
  const map = new Map<string, ErasedTool>();
  for (const t of tools) {
    if (map.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}

export {
  bashTool,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  taskTool,
  todoTool,
  writeFileTool,
};
export type { ErasedTool, Tool };
