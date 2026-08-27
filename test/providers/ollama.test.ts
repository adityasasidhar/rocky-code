import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTO_CONTEXT_CAP,
  mapDoneReason,
  OllamaProvider,
  parseContextLength,
  toOllamaMessages,
} from "../../src/core/provider/ollama.ts";
import { DEFAULT_CONTEXT_WINDOW, type Message } from "../../src/core/types.ts";
import {
  baseRequest,
  collect,
  lastEvent,
  ndjson,
  serveChunks,
  serveChunksThenHang,
  serveHanging,
  serveRoutes,
  textOf,
  thinkingOf,
  type TestServer,
} from "./server.ts";

let server: TestServer | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

const provider = (url: string, over = {}) => new OllamaProvider({ baseUrl: url, ...over });

const done = (over = {}) => ({
  message: { role: "assistant", content: "" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 26,
  eval_count: 8,
  ...over,
});

describe("OllamaProvider — streaming", () => {
  test("streams text and reports local token counts", async () => {
    server = serveChunks([
      ndjson({ message: { role: "assistant", content: "Hel" }, done: false }),
      ndjson({ message: { role: "assistant", content: "lo" }, done: false }),
      ndjson(done()),
    ]);

    const events = await collect(provider(server.url).stream(baseRequest()));
    expect(textOf(events)).toBe("Hello");

    const end = lastEvent(events);
    expect(end.stopReason).toBe("end_turn");
    expect(end.usage.inputTokens).toBe(26);
    expect(end.usage.outputTokens).toBe(8);
    // Local models have no prompt cache.
    expect(end.usage.cacheReadInputTokens).toBe(0);
  });

  test("streams the thinking field but keeps it out of the transcript", async () => {
    server = serveChunks([
      ndjson({ message: { role: "assistant", content: "", thinking: "reasoning…" }, done: false }),
      ndjson({ message: { role: "assistant", content: "answer" }, done: false }),
      ndjson(done()),
    ]);

    const events = await collect(provider(server.url).stream(baseRequest()));
    expect(thinkingOf(events)).toBe("reasoning…");
    expect(lastEvent(events).message.content).toEqual([{ type: "text", text: "answer" }]);
  });

  test("synthesizes ids for tool calls, which Ollama does not provide", async () => {
    server = serveChunks([
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "grep", arguments: { pattern: "x" } } }],
        },
        done: false,
      }),
      ndjson(done()),
    ]);

    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(end.stopReason).toBe("tool_use");
    expect(end.message.content).toEqual([
      { type: "tool_use", id: "call_0_grep", name: "grep", input: { pattern: "x" } },
    ]);
  });

  test("arguments arrive already parsed, not as a JSON string", async () => {
    server = serveChunks([
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "bash", arguments: { command: "ls", timeout_ms: 5 } } }],
        },
        done: false,
      }),
      ndjson(done()),
    ]);

    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(end.message.content[0]).toMatchObject({
      input: { command: "ls", timeout_ms: 5 },
    });
  });

  test("multiple tool calls get distinct ids", async () => {
    server = serveChunks([
      ndjson({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "glob", arguments: {} } },
            { function: { name: "glob", arguments: {} } },
          ],
        },
        done: false,
      }),
      ndjson(done()),
    ]);

    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    const ids = end.message.content.map((b) => (b.type === "tool_use" ? b.id : ""));
    expect(new Set(ids).size).toBe(2);
  });

  test("done_reason length maps to max_tokens", async () => {
    server = serveChunks([ndjson(done({ done_reason: "length" }))]);
    expect(lastEvent(await collect(provider(server.url).stream(baseRequest()))).stopReason).toBe(
      "max_tokens",
    );
  });
});

describe("OllamaProvider — request shape", () => {
  test("declares the context window, so Ollama does not silently truncate", async () => {
    // Ollama defaults num_ctx to ~4096 and drops the head of a longer prompt.
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url, { contextWindow: 32_000 }).stream(baseRequest()));
    expect(server.bodies[0]!["options"]).toEqual({ num_predict: 1024, num_ctx: 32_000 });
  });

  test("omits num_ctx before prepare(), rather than guessing memory to spend", async () => {
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url).stream(baseRequest()));
    expect(server.bodies[0]!["options"]).toEqual({ num_predict: 1024 });
  });

  test("maps maxTokens to options.num_predict and sends tools", async () => {
    server = serveChunks([ndjson(done())]);

    await collect(
      provider(server.url).stream(
        baseRequest({
          tools: [{ name: "glob", description: "list", inputSchema: { type: "object" } }],
        }),
      ),
    );

    const body = server.bodies[0]!;
    expect(body["options"]).toEqual({ num_predict: 1024 });
    expect(body["stream"]).toBe(true);
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "glob", description: "list", parameters: { type: "object" } },
      },
    ]);
  });

  test("think is off unless the model says it can, or config forces it", async () => {
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url).stream(baseRequest({ thinking: true })));
    expect(server.bodies[0]!["think"]).toBeUndefined();

    server.stop();
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url, { think: true }).stream(baseRequest({ thinking: true })));
    expect(server.bodies[0]!["think"]).toBe(true);
  });

  test("a turn that does not want thinking says so explicitly", async () => {
    // Found live: a reasoning model reasons by default. Omitting `think` does
    // not disable it, so --no-thinking was silently ignored. We must send false.
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url, { think: true }).stream(baseRequest({ thinking: false })));
    expect(server.bodies[0]!["think"]).toBe(false);
  });

  test("think stays absent for a model we have no reason to think can think", async () => {
    // Never probed, never configured: sending `think` at all would be an error.
    server = serveChunks([ndjson(done())]);
    await collect(provider(server.url).stream(baseRequest({ thinking: false })));
    expect(server.bodies[0]!["think"]).toBeUndefined();
  });

  test("local inference costs nothing", () => {
    expect(new OllamaProvider({ baseUrl: "http://x" }).pricing()).toEqual({
      input: 0,
      output: 0,
    });
  });
});

describe("parseContextLength", () => {
  test("finds the architecture-namespaced key", () => {
    expect(
      parseContextLength({ "general.architecture": "qwen35", "qwen35.context_length": 262_144 }),
    ).toBe(262_144);
  });

  test("falls back to any *.context_length key", () => {
    expect(parseContextLength({ "llama.context_length": 8192 })).toBe(8192);
  });

  test("ignores unrelated and malformed entries", () => {
    expect(parseContextLength({ "qwen35.embedding_length": 2560 })).toBeUndefined();
    expect(parseContextLength({ "llama.context_length": "8192" })).toBeUndefined();
    expect(parseContextLength({ "llama.context_length": 0 })).toBeUndefined();
    expect(parseContextLength(undefined)).toBeUndefined();
    expect(parseContextLength({})).toBeUndefined();
  });
});

describe("OllamaProvider — prepare()", () => {
  const show = (over: Record<string, unknown> = {}) => ({
    capabilities: ["completion", "tools"],
    model_info: { "general.architecture": "qwen35", "qwen35.context_length": 262_144 },
    ...over,
  });

  test("a big model's window is capped at the 126k default, never above", async () => {
    // The cap IS the default window: a capable model always gets the full
    // 126k, and only an explicit contextWindow in config can go past it.
    server = serveRoutes({ "/api/show": show(), "/api/chat": ndjson(done()) });
    const p = provider(server.url);

    expect(p.contextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
    await p.prepare("qwen3.5:4b");
    expect(p.contextWindow()).toBe(AUTO_CONTEXT_CAP);
    expect(p.contextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("a small model's real window is used as-is, not padded up to the cap", async () => {
    server = serveRoutes({
      "/api/show": show({ model_info: { "llama.context_length": 8192 } }),
      "/api/chat": ndjson(done()),
    });
    const p = provider(server.url);
    await p.prepare("tiny");
    expect(p.contextWindow()).toBe(8192);
  });

  test("the discovered window is the number actually sent as num_ctx", async () => {
    // Accounting and request must never drift.
    server = serveRoutes({
      "/api/show": show({ model_info: { "llama.context_length": 8192 } }),
      "/api/chat": ndjson(done()),
    });
    const p = provider(server.url);
    await p.prepare("tiny");
    await collect(p.stream(baseRequest()));

    expect(server.bodies[1]!["options"]).toEqual({ num_predict: 1024, num_ctx: 8192 });
  });

  test("explicit config wins over discovery, in both directions", async () => {
    server = serveRoutes({ "/api/show": show(), "/api/chat": ndjson(done()) });
    const p = provider(server.url, { contextWindow: 4096 });
    await p.prepare("qwen3.5:4b");

    expect(p.contextWindow()).toBe(4096);
    await collect(p.stream(baseRequest()));
    expect(server.bodies[1]!["options"]).toMatchObject({ num_ctx: 4096 });
  });

  test("enables think for a model that reports the capability", async () => {
    server = serveRoutes({
      "/api/show": show({ capabilities: ["completion", "tools", "thinking"] }),
      "/api/chat": ndjson(done()),
    });
    const p = provider(server.url);
    await p.prepare("qwen3.5:4b");
    await collect(p.stream(baseRequest({ thinking: true })));
    expect(server.bodies[1]!["think"]).toBe(true);
  });

  test("leaves think off for a model that does not — Ollama would error", async () => {
    server = serveRoutes({ "/api/show": show(), "/api/chat": ndjson(done()) });
    const p = provider(server.url);
    await p.prepare("plain");
    await collect(p.stream(baseRequest({ thinking: true })));
    expect(server.bodies[1]!["think"]).toBeUndefined();
  });

  test("a probed thinking model is told not to think when thinking is off", async () => {
    server = serveRoutes({
      "/api/show": show({ capabilities: ["thinking"] }),
      "/api/chat": ndjson(done()),
    });
    const p = provider(server.url);
    await p.prepare("qwen3.5:4b");
    await collect(p.stream(baseRequest({ thinking: false })));
    expect(server.bodies[1]!["think"]).toBe(false);
  });

  test("config can force think off for a capable model", async () => {
    server = serveRoutes({
      "/api/show": show({ capabilities: ["thinking"] }),
      "/api/chat": ndjson(done()),
    });
    const p = provider(server.url, { think: false });
    await p.prepare("qwen3.5:4b");
    await collect(p.stream(baseRequest({ thinking: true })));
    // Explicitly false, not absent: absent means "reason by default".
    expect(server.bodies[1]!["think"]).toBe(false);
  });

  test.each([
    ["a 404 (model not pulled)", { "/api/show": { status: 404 } }],
    ["a 500", { "/api/show": { status: 500 } }],
    ["an unexpected payload", { "/api/show": { nonsense: true } }],
    ["a payload with no context_length", { "/api/show": { model_info: {} } }],
  ])("survives %s, keeping defaults", async (_label, routes) => {
    server = serveRoutes({ ...routes, "/api/chat": ndjson(done()) });
    const p = provider(server.url);

    await expect(p.prepare("missing")).resolves.toBeUndefined();
    expect(p.contextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);

    // And having failed, it does not then send a bogus num_ctx.
    await collect(p.stream(baseRequest()));
    expect(server.bodies.at(-1)!["options"]).toEqual({ num_predict: 1024 });
  });

  test("survives an unreachable server without throwing", async () => {
    const p = new OllamaProvider({ baseUrl: "http://127.0.0.1:1" });
    await expect(p.prepare("x")).resolves.toBeUndefined();
    expect(p.contextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("asks about the model it was given", async () => {
    server = serveRoutes({ "/api/show": show(), "/api/chat": ndjson(done()) });
    await provider(server.url).prepare("qwen3.5:4b");
    expect(server.bodies[0]).toEqual({ model: "qwen3.5:4b" });
  });
});

describe("OllamaProvider — failure paths", () => {
  test("an error inside a 200 stream is raised, not silently ignored", async () => {
    server = serveChunks([ndjson({ error: "model 'nope' not found" })]);
    await expect(collect(provider(server.url).stream(baseRequest()))).rejects.toThrow(
      /model 'nope' not found/,
    );
  });

  test("abort yields an aborted turn rather than throwing", async () => {
    server = serveHanging();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);

    const end = lastEvent(
      await collect(provider(server.url).stream(baseRequest({ signal: ac.signal }))),
    );
    expect(end.stopReason).toBe("aborted");
  });

  test("a partial answer is salvaged when the user aborts mid-stream", async () => {
    server = serveChunksThenHang([
      ndjson({ message: { role: "assistant", content: "partial" }, done: false }),
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);

    const events = await collect(provider(server.url).stream(baseRequest({ signal: ac.signal })));
    const end = lastEvent(events);

    expect(textOf(events)).toBe("partial");
    expect(end.stopReason).toBe("aborted");
    // The text is kept, so the next turn still has the context. No dangling
    // tool_use is ever emitted on an abort.
    expect(end.message.content).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("toOllamaMessages", () => {
  test("tool results are matched to calls by name, since Ollama has no ids", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_0_bash", name: "bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_0_bash", content: "out", is_error: false },
        ],
      },
    ];

    expect(toOllamaMessages(messages)).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "bash", arguments: { command: "ls" } } }],
      },
      { role: "tool", content: "out", tool_name: "bash" },
    ]);
  });

  test("arguments are sent as an object, not a string", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c", name: "glob", input: { pattern: "*.ts" } }],
      },
    ];
    const out = toOllamaMessages(messages)[0]!;
    expect(out.tool_calls![0]!.function.arguments).toEqual({ pattern: "*.ts" });
  });

  test("thinking blocks are dropped", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(toOllamaMessages(messages)).toEqual([{ role: "assistant", content: "answer" }]);
  });

  test("an unknown tool_use_id yields an empty tool_name rather than crashing", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "x", is_error: true }],
      },
    ];
    expect(toOllamaMessages(messages)).toEqual([
      { role: "tool", content: "x", tool_name: "" },
    ]);
  });
});

describe("mapDoneReason", () => {
  test("maps ollama's stop reasons", () => {
    expect(mapDoneReason("length")).toBe("max_tokens");
    expect(mapDoneReason("stop")).toBe("end_turn");
    expect(mapDoneReason(undefined)).toBe("end_turn");
  });
});
