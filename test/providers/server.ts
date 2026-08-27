import type { ProviderRequest, StreamEvent } from "../../src/core/types.ts";

export type TestServer = {
  url: string;
  /** Bodies of every request received, parsed as JSON. */
  bodies: Record<string, unknown>[];
  stop: () => void;
};

/** Serve a fixed sequence of raw byte chunks, exactly as written. */
export function serveChunks(chunks: string[], status = 200): TestServer {
  return serve(async (req, bodies) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    if (status !== 200) return new Response(chunks.join(""), { status });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  });
}

/** A stream that opens and then never sends anything, for abort tests. */
export function serveHanging(): TestServer {
  return serve(async (req, bodies) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately never enqueue or close.
      },
    });
    return new Response(stream);
  });
}

/**
 * Route by pathname. Values are either a JSON body (served as-is) or a status
 * code to fail with. Lets a test stand in for both /api/show and /api/chat.
 */
export function serveRoutes(
  routes: Record<string, unknown | { status: number }>,
): TestServer {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try {
        bodies.push((await req.json()) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      const route = routes[path];
      if (route === undefined) return new Response("not found", { status: 404 });
      if (typeof route === "object" && route !== null && "status" in route) {
        return new Response("error", { status: (route as { status: number }).status });
      }
      if (typeof route === "string") {
        // Raw body: an NDJSON chat stream.
        return new Response(route);
      }
      return Response.json(route);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    stop: () => server.stop(true),
  };
}

/**
 * Fail the first `failures` requests with `status`, then stream `chunks`.
 * For retry tests; `headers` (e.g. Retry-After) ride on the failures.
 */
export function serveFlaky(
  failures: number,
  status: number,
  chunks: string[],
  headers: Record<string, string> = {},
): TestServer {
  let failed = 0;
  return serve(async (req, bodies) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    if (failed < failures) {
      failed++;
      return new Response("flaky error", { status, headers });
    }
    return new Response(chunks.join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
}

/**
 * Accept the connection and never produce response headers. For first-byte
 * timeout tests. `hits` counts attempts, since no request body ever parses.
 */
export function serveNoHeaders(): TestServer & { hits: () => number } {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      count++;
      return new Promise<Response>(() => {
        // Deliberately never resolved.
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies: [],
    stop: () => server.stop(true),
    hits: () => count,
  };
}

/** Emit some chunks, then hold the connection open. For partial-abort tests. */
export function serveChunksThenHang(chunks: string[]): TestServer {
  return serve(async (req, bodies) => {
    bodies.push((await req.json()) as Record<string, unknown>);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        // Never closed: the client must abort.
      },
    });
    return new Response(stream);
  });
}

function serve(
  handler: (
    req: Request,
    bodies: Record<string, unknown>[],
  ) => Promise<Response>,
): TestServer {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (req) => handler(req, bodies),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    stop: () => server.stop(true),
  };
}

/** Format SSE frames. */
export const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
export const sseDone = (): string => "data: [DONE]\n\n";

/** Format an NDJSON line. */
export const ndjson = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

export const baseRequest = (
  over: Partial<ProviderRequest> = {},
): ProviderRequest => ({
  model: "test-model",
  system: [{ text: "You are Rocky." }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxTokens: 1024,
  effort: "high",
  thinking: false,
  signal: new AbortController().signal,
  ...over,
});

export async function collect(
  gen: AsyncGenerator<StreamEvent, void, undefined>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

export const lastEvent = (events: StreamEvent[]) =>
  events.at(-1) as Extract<StreamEvent, { type: "message_end" }>;

export const textOf = (events: StreamEvent[]): string =>
  events
    .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

export const thinkingOf = (events: StreamEvent[]): string =>
  events
    .filter(
      (e): e is Extract<StreamEvent, { type: "thinking_delta" }> =>
        e.type === "thinking_delta",
    )
    .map((e) => e.text)
    .join("");
