/**
 * Minimal line diff. Used for edit_file diagnostics, permission prompts, and
 * the TUI. Deliberately dependency-free and deterministic.
 */

export type DiffOp = { kind: "ctx" | "add" | "del"; text: string };

const MAX_DP_CELLS = 4_000_000;

/** LCS-based line diff. Falls back to whole-block replace on huge inputs. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length * b.length > MAX_DP_CELLS) {
    return [
      ...a.map((text): DiffOp => ({ kind: "del", text })),
      ...b.map((text): DiffOp => ({ kind: "add", text })),
    ];
  }

  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i:] and b[j:]
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

const sign = (k: DiffOp["kind"]) => (k === "add" ? "+" : k === "del" ? "-" : " ");

/** Unified-ish diff body with `context` unchanged lines around each hunk. */
export function formatDiff(ops: DiffOp[], context = 3): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === "ctx") return;
    for (
      let k = Math.max(0, idx - context);
      k <= Math.min(ops.length - 1, idx + context);
      k++
    ) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let skipping = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) {
      if (!skipping) {
        out.push("…");
        skipping = true;
      }
      continue;
    }
    skipping = false;
    out.push(`${sign(ops[idx]!.kind)} ${ops[idx]!.text}`);
  }
  return out.join("\n");
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Fuzzy matching — powers the "0 matches" diagnostic in edit_file.
// ---------------------------------------------------------------------------

/** Levenshtein distance, two-row DP. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** 0..1. Exact edit distance for small inputs, trigram Jaccard for large ones. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  if (a.length * b.length <= 400_000) {
    return 1 - editDistance(a, b) / longest;
  }
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export type FuzzyMatch = { startLine: number; text: string; score: number };

/**
 * Find the span of `haystack` that most resembles `needle`, aligned to line
 * boundaries. Returns undefined when nothing scores above `threshold`.
 */
export function findClosestBlock(
  haystack: string,
  needle: string,
  threshold = 0.5,
): FuzzyMatch | undefined {
  const hay = haystack.split("\n");
  const ned = needle.split("\n");
  const window = ned.length;
  if (window === 0 || hay.length < window) return undefined;

  const cheap = hay.length > 5_000;
  const firstNeedleLine = ned[0]!;

  let best: FuzzyMatch | undefined;
  for (let i = 0; i + window <= hay.length; i++) {
    // On big files, only score windows whose first line is plausibly the anchor.
    if (cheap && similarity(hay[i]!, firstNeedleLine) < 0.4) continue;
    const text = hay.slice(i, i + window).join("\n");
    const score = similarity(text, needle);
    if (!best || score > best.score) best = { startLine: i + 1, text, score };
    if (best.score === 1) break;
  }
  return best && best.score >= threshold ? best : undefined;
}

/** 1-indexed line numbers where `needle` occurs in `haystack`. */
export function occurrenceLines(haystack: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    let line = 1;
    for (let i = 0; i < idx; i++) if (haystack.charCodeAt(i) === 10) line++;
    lines.push(line);
    from = idx + Math.max(needle.length, 1);
  }
  return lines;
}
