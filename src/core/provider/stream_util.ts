/**
 * Line-oriented streaming helpers shared by the OpenAI and Ollama providers.
 *
 * Both wire formats are newline-delimited, and both will happily split a line
 * across two network chunks. Everything here is written to survive that.
 */

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    endpoint: string,
  ) {
    super(`${endpoint} returned ${status}: ${truncate(body, 400)}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * The server produced no response headers in time. Deliberately NOT named
 * "AbortError": both providers classify AbortError as "the user interrupted",
 * and a timeout that masqueraded as a user abort would end the turn silently
 * instead of surfacing as the provider failure it is.
 */
export class ProviderTimeoutError extends Error {
  constructor(endpoint: string, timeoutMs: number, attempts: number) {
    super(
      `${endpoint} did not respond within ${timeoutMs}ms ` +
        `(${attempts} attempt${attempts === 1 ? "" : "s"})`,
    );
    this.name = "ProviderTimeoutError";
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Yields complete lines from a byte stream, buffering partial trailing data. */
export async function* iterateLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Server-Sent Events: `data: {...}` lines, terminated by `data: [DONE]`.
 * Comments, blank lines, and non-`data:` fields are ignored.
 */
export async function* iterateSSE<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  for await (const line of iterateLines(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") return;
      continue;
    }
    yield JSON.parse(payload) as T;
  }
}

/** Newline-delimited JSON, one object per line. Ollama's native format. */
export async function* iterateNdjson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  for await (const line of iterateLines(body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as T;
  }
}

export type RetryOptions = {
  /** Additional attempts after the first. Default 4 (5 attempts, like the SDK). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** How long the server gets to produce response *headers*. Never applies mid-stream. */
  firstByteTimeoutMs?: number;
};

/** Transient by contract; everything else in 4xx is our bug or the user's key. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/** `Retry-After` is either seconds or an HTTP-date. Returns ms, or undefined. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Full-jitter exponential backoff, with `Retry-After` honored as a floor. */
export function computeDelay(
  attempt: number,
  retryAfter: string | null,
  base: number,
  max: number,
): number {
  const exp = Math.min(max, base * 2 ** attempt);
  const jittered = exp * (0.5 + Math.random() * 0.5);
  const floor = parseRetryAfter(retryAfter);
  // A server that asks for an hour is asking us to give up; cap what we honor.
  return floor === undefined ? jittered : Math.max(jittered, Math.min(floor, 30_000));
}

/** Resolves after `ms`, or immediately when the signal fires — never rejects. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * POST JSON and hand back the body stream, or throw with the server's message.
 *
 * Transient failures — network errors, retryable statuses, and a server that
 * never produces headers — are retried with full-jitter exponential backoff.
 * The retry scope is exactly "before the first byte": once headers arrive the
 * stream is handed to the caller, and a mid-stream failure surfaces there.
 *
 * The user's signal always wins: it aborts the in-flight attempt, the backoff
 * sleep, and the loop itself, and the abort reason is rethrown untouched so
 * the providers classify it as an interrupt, not a provider failure.
 */
export async function postStream(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const timeoutMs = opts.firstByteTimeoutMs ?? 60_000;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();

    // Each attempt gets its own controller: the user's signal forwards into
    // it, and a timer aborts it if headers never arrive. The timer is cleared
    // the moment they do — a long generation must never be killed mid-stream.
    const attemptCtl = new AbortController();
    const onUserAbort = () => attemptCtl.abort();
    signal.addEventListener("abort", onUserAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptCtl.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: payload,
        signal: attemptCtl.signal,
      });
      clearTimeout(timer);

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "<unreadable body>");
        signal.removeEventListener("abort", onUserAbort);
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(
            computeDelay(attempt, res.headers.get("retry-after"), baseDelay, maxDelay),
            signal,
          );
          continue;
        }
        throw new ProviderHttpError(res.status, text, url);
      }

      // Success: the abort forwarder stays attached so the user's Esc still
      // cancels the body read. It is `once`, on a per-turn signal — no leak.
      return res.body;
    } catch (err) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onUserAbort);
      // A genuine user abort is rethrown untouched (isAbort checks the signal
      // first, so classification holds even if err is our own sentinel).
      if (signal.aborted) throw err;
      if (err instanceof ProviderHttpError) throw err; // decided above
      if (timedOut && attempt >= maxRetries) {
        throw new ProviderTimeoutError(url, timeoutMs, attempt + 1);
      }
      if (!timedOut && attempt >= maxRetries) throw err; // network, exhausted
      await sleep(computeDelay(attempt, null, baseDelay, maxDelay), signal);
    }
  }
}

/**
 * Accumulates streamed tool-call fragments.
 *
 * OpenAI streams `arguments` as a string in pieces, keyed by array index; the
 * `id` and `name` arrive only on the first fragment. Assembling this correctly
 * is the single fiddliest part of the OpenAI wire format.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  add(index: number, delta: { id?: string; name?: string; args?: string }): void {
    const slot = this.slots.get(index) ?? { id: "", name: "", args: "" };
    if (delta.id) slot.id = delta.id;
    if (delta.name) slot.name = delta.name;
    if (delta.args) slot.args += delta.args;
    this.slots.set(index, slot);
  }

  has(index: number): boolean {
    return this.slots.has(index);
  }

  /** Ordered by stream index, with ids synthesized when the server omits them. */
  finish(): { id: string; name: string; input: unknown }[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, slot]) => ({
        id: slot.id || `call_${index}_${slot.name}`,
        name: slot.name,
        input: parseArgs(slot.args),
      }));
  }
}

/**
 * Tool arguments arrive as a JSON string. A model can emit malformed JSON; that
 * must surface as a tool-input validation error the model can fix, not as a
 * crash that kills the session.
 */
export function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __malformed_arguments__: raw };
  }
}
