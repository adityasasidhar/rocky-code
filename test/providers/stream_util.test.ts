import { describe, expect, test } from "bun:test";
import {
  computeDelay,
  iterateLines,
  iterateNdjson,
  iterateSSE,
  parseArgs,
  parseRetryAfter,
  postStream,
  ProviderHttpError,
  ProviderTimeoutError,
  ToolCallAccumulator,
} from "../../src/core/provider/stream_util.ts";
import { serveFlaky, serveNoHeaders } from "./server.ts";

/** Build a byte stream from arbitrary chunk boundaries. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const drain = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
};

describe("iterateLines", () => {
  test("splits on newlines", async () => {
    expect(await drain(iterateLines(streamOf(["a\nb\nc\n"])))).toEqual(["a", "b", "c"]);
  });

  test("reassembles a line split across chunks", async () => {
    expect(await drain(iterateLines(streamOf(["he", "llo\nwor", "ld\n"])))).toEqual([
      "hello",
      "world",
    ]);
  });

  test("emits a trailing line with no newline", async () => {
    expect(await drain(iterateLines(streamOf(["a\nb"])))).toEqual(["a", "b"]);
  });

  test("strips CR from CRLF", async () => {
    expect(await drain(iterateLines(streamOf(["a\r\nb\r\n"])))).toEqual(["a", "b"]);
  });

  test("reassembles a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("é\n"); // 0xc3 0xa9 0x0a
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 1));
        c.enqueue(bytes.slice(1));
        c.close();
      },
    });
    expect(await drain(iterateLines(stream))).toEqual(["é"]);
  });
});

describe("iterateSSE", () => {
  test("parses data frames and stops at [DONE]", async () => {
    const chunks = [
      'data: {"n":1}\n\n',
      'data: {"n":2}\n\n',
      "data: [DONE]\n\n",
      'data: {"n":3}\n\n', // must not be yielded
    ];
    expect(await drain(iterateSSE(streamOf(chunks)))).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("ignores comments, blank lines, and non-data fields", async () => {
    const chunks = [": ping\n", "\n", "event: message\n", 'data: {"n":1}\n\n'];
    expect(await drain(iterateSSE(streamOf(chunks)))).toEqual([{ n: 1 }]);
  });

  test("handles a frame split mid-JSON", async () => {
    expect(await drain(iterateSSE(streamOf(['data: {"a":', '"b"}\n\n'])))).toEqual([
      { a: "b" },
    ]);
  });
});

describe("iterateNdjson", () => {
  test("parses one object per line, skipping blanks", async () => {
    expect(await drain(iterateNdjson(streamOf(['{"a":1}\n', "\n", '{"a":2}\n'])))).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  test("handles a line split across chunks", async () => {
    expect(await drain(iterateNdjson(streamOf(['{"a', '":1}\n'])))).toEqual([{ a: 1 }]);
  });
});

describe("ToolCallAccumulator", () => {
  test("assembles arguments streamed in fragments", () => {
    const acc = new ToolCallAccumulator();
    acc.add(0, { id: "call_1", name: "grep" });
    acc.add(0, { args: '{"pat' });
    acc.add(0, { args: 'tern":"x"}' });

    expect(acc.finish()).toEqual([
      { id: "call_1", name: "grep", input: { pattern: "x" } },
    ]);
  });

  test("keeps parallel calls separate and ordered by index", () => {
    const acc = new ToolCallAccumulator();
    acc.add(1, { id: "b", name: "two", args: "{}" });
    acc.add(0, { id: "a", name: "one", args: "{}" });

    expect(acc.finish().map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("synthesizes an id when the server omits one", () => {
    const acc = new ToolCallAccumulator();
    acc.add(0, { name: "bash", args: "{}" });
    expect(acc.finish()[0]!.id).toBe("call_0_bash");
  });

  test("empty arguments become an empty object", () => {
    const acc = new ToolCallAccumulator();
    acc.add(0, { id: "x", name: "glob" });
    expect(acc.finish()[0]!.input).toEqual({});
  });
});

describe("parseArgs", () => {
  test("parses valid JSON", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
  });

  test("empty string becomes an empty object", () => {
    expect(parseArgs("  ")).toEqual({});
  });

  test("malformed JSON is preserved for the model to see, not thrown", () => {
    expect(parseArgs("{oops")).toEqual({ __malformed_arguments__: "{oops" });
  });
});

describe("postStream retries", () => {
  // Tiny delays: these tests exercise the policy, not the clock.
  const fast = { baseDelayMs: 1, maxDelayMs: 4, firstByteTimeoutMs: 5_000 };
  const never = new AbortController().signal;

  test("a transient 500 is retried and the stream comes back", async () => {
    const server = serveFlaky(2, 500, ["hello"]);
    try {
      const body = await postStream(server.url, { q: 1 }, {}, never, fast);
      const text = await new Response(body).text();
      expect(text).toBe("hello");
      // Two failures + one success — and the same payload every time.
      expect(server.bodies).toHaveLength(3);
      expect(server.bodies.every((b) => (b as { q: number }).q === 1)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a 400 is our bug, not the weather: no retry", async () => {
    const server = serveFlaky(99, 400, []);
    try {
      await expect(postStream(server.url, {}, {}, never, fast)).rejects.toThrow(
        ProviderHttpError,
      );
      expect(server.bodies).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("retries are finite: a persistent 503 gives up with the real error", async () => {
    const server = serveFlaky(99, 503, []);
    try {
      const err = await postStream(server.url, {}, {}, never, {
        ...fast,
        maxRetries: 2,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect((err as ProviderHttpError).status).toBe(503);
      expect(server.bodies).toHaveLength(3); // 1 + 2 retries
    } finally {
      server.stop();
    }
  });

  test("Retry-After is honored as a floor on the backoff", async () => {
    const server = serveFlaky(1, 429, ["ok"], { "retry-after": "1" });
    try {
      const started = Date.now();
      await postStream(server.url, {}, {}, never, fast);
      // The jittered base delay is ~1ms; only the header explains a 1s wait.
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      server.stop();
    }
  });

  test("a server that never sends headers is a timeout, never an abort", async () => {
    const server = serveNoHeaders();
    try {
      const err = await postStream(server.url, {}, {}, never, {
        ...fast,
        firstByteTimeoutMs: 30,
        maxRetries: 2,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      // The name matters: providers classify AbortError as a user interrupt,
      // and a timeout wearing that name would silently end the turn.
      expect(err).toBeInstanceOf(ProviderTimeoutError);
      expect((err as Error).name).not.toBe("AbortError");
      expect(server.hits()).toBe(3);
    } finally {
      server.stop();
    }
  });

  test("a user abort during backoff wins immediately and stays an abort", async () => {
    const server = serveFlaky(99, 500, []);
    try {
      const ac = new AbortController();
      const started = Date.now();
      const pending = postStream(server.url, {}, {}, ac.signal, {
        baseDelayMs: 60_000, // an abort that waited out the backoff would time the test out
        maxDelayMs: 60_000,
      });
      setTimeout(() => ac.abort(), 20);
      const err = await pending.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
      // Classification contract: the signal is aborted and the error is not
      // one of our provider-failure types.
      expect(ac.signal.aborted).toBe(true);
      expect(err).not.toBeInstanceOf(ProviderTimeoutError);
      expect(err).not.toBeInstanceOf(ProviderHttpError);
    } finally {
      server.stop();
    }
  });

  test("network-level failure (connection refused) retries then surfaces", async () => {
    // A port nothing listens on: fetch rejects at the socket, not with a status.
    const err = await postStream("http://127.0.0.1:1", {}, {}, never, {
      ...fast,
      maxRetries: 1,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect((err as Error).name).not.toBe("AbortError");
  });
});

describe("computeDelay / parseRetryAfter", () => {
  test("backoff grows exponentially with full jitter in [half, full]", () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const full = Math.min(4_000, 500 * 2 ** attempt);
      for (let i = 0; i < 20; i++) {
        const d = computeDelay(attempt, null, 500, 4_000);
        expect(d).toBeGreaterThanOrEqual(full / 2);
        expect(d).toBeLessThanOrEqual(full);
      }
    }
  });

  test("Retry-After in seconds floors the delay, capped at 30s", () => {
    expect(computeDelay(0, "2", 1, 10)).toBeGreaterThanOrEqual(2_000);
    // An hour-long ask is capped, not obeyed.
    expect(computeDelay(0, "3600", 1, 10)).toBeLessThanOrEqual(30_000);
  });

  test("Retry-After as an HTTP-date converts to a wait from now", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(3_000);
    expect(ms).toBeLessThanOrEqual(5_500);
  });

  test("absent or garbage headers mean no floor", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
