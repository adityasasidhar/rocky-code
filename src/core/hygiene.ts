import type { ToolResult } from "../tools/types.ts";
import type { Archiver } from "./archive.ts";
import { truncateMiddle } from "./truncate.ts";

/**
 * Cap a tool result before it enters the transcript.
 *
 * Applied centrally, to every tool, so a new tool cannot forget to do it and
 * blow the context window on its first bad day. A capped result keeps its head
 * and tail, states how many bytes were dropped, and points at the full copy on
 * disk so the model can go read it.
 *
 * `meta` is not capped: it never reaches the model.
 */
export function capToolResult(
  result: ToolResult,
  toolName: string,
  maxBytes: number,
  archive: Archiver,
): ToolResult {
  const bytes = Buffer.byteLength(result.output, "utf8");
  if (bytes <= maxBytes) return result;

  const path = archive(toolName, result.output);
  const { text } = truncateMiddle(
    result.output,
    maxBytes,
    path ? `full output at ${path}` : "output was not archived",
  );

  return {
    ...result,
    output: text,
    meta: { ...result.meta, truncated: true, originalBytes: bytes, ...(path ? { archivedAt: path } : {}) },
  };
}
