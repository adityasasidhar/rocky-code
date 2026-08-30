/** Inline `<think>` tags emitted by some OpenAI-compatible reasoning models. */
export const THINK_OPEN = "<think>";
export const THINK_CLOSE = "</think>";

/** A `<think>`-tagged span and the visible text around it, in arrival order. */
export interface ThinkSegment {
  kind: "text" | "thinking";
  text: string;
}

/**
 * Splits inline `<think>…</think>` reasoning out of streamed message content.
 *
 * TrueForge reports reasoning in its own `reasoningContent` field for providers
 * that separate it, but a model reached through an OpenAI-compatible `custom`
 * provider (MiniMax-M3, most local reasoning models) emits the tags inline in
 * `content` instead, and nothing upstream strips them. Left alone they render
 * as literal text and, worse, land in `-p` stdout, which is the answer meant to
 * be piped somewhere.
 *
 * Deltas arrive mid-tag, so a chunk ending in `"…done.</thi"` must not be
 * emitted yet. Anything that could still become a tag is held back until the
 * next chunk decides it; `flush()` releases the remainder at message end,
 * because a partial tag that never completes was ordinary text all along.
 */
export class ThinkTagFilter {
  private inside = false;
  private held = "";

  push(chunk: string): ThinkSegment[] {
    const segments: ThinkSegment[] = [];
    let buffer = this.held + chunk;
    this.held = "";

    while (buffer.length > 0) {
      const tag = this.inside ? THINK_CLOSE : THINK_OPEN;
      const at = buffer.indexOf(tag);
      if (at >= 0) {
        const before = buffer.slice(0, at);
        if (before) segments.push({ kind: this.inside ? "thinking" : "text", text: before });
        buffer = buffer.slice(at + tag.length);
        this.inside = !this.inside;
        continue;
      }
      // No complete tag. Hold back only a suffix that could still become one,
      // so ordinary text streams without waiting on the next chunk.
      const keep = partialTagSuffix(buffer, tag);
      const emit = buffer.slice(0, buffer.length - keep);
      if (emit) segments.push({ kind: this.inside ? "thinking" : "text", text: emit });
      this.held = buffer.slice(buffer.length - keep);
      break;
    }
    return segments;
  }

  /** Release whatever was held back, treating an unfinished tag as text. */
  flush(): ThinkSegment[] {
    if (!this.held) return [];
    const text = this.held;
    this.held = "";
    return [{ kind: this.inside ? "thinking" : "text", text }];
  }
}

/** Length of the longest suffix of `buffer` that is a proper prefix of `tag`. */
function partialTagSuffix(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(buffer.slice(buffer.length - len))) return len;
  }
  return 0;
}
