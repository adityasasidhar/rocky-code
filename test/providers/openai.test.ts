import { afterEach, describe, expect, test } from "bun:test";
import {
  mapEffort,
  mapFinish,
  OpenAICompatibleProvider,
  toChatMessages,
} from "../../src/core/provider/openai.ts";
import { ProviderHttpError } from "../../src/core/provider/stream_util.ts";
import type { Message } from "../../src/core/types.ts";
import {
  baseRequest,
  collect,
  lastEvent,
  serveChunks,
  serveChunksThenHang,
  serveHanging,
  sse,
  sseDone,
  textOf,
  thinkingOf,
  type TestServer,
} from "./server.ts";

let server: TestServer | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

const provider = (url: string, over = {}) =>
  new OpenAICompatibleProvider({ baseUrl: `${url}/v1`, apiKey: "sk-test", ...over });

const delta = (d: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

describe("OpenAICompatibleProvider — streaming", () => {
  test("streams text and ends the turn", async () => {
    server = serveChunks([
      sse(delta({ role: "assistant", content: "Hel" })),
      sse(delta({ content: "lo" })),
      sse(delta({}, "stop")),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      sseDone(),
    ]);

    const events = await collect(provider(server.url).stream(baseRequest()));
    expect(textOf(events)).toBe("Hello");

    const end = lastEvent(events);
    expect(end.stopReason).toBe("end_turn");
    expect(end.message.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(end.usage.inputTokens).toBe(10);
    expect(end.usage.outputTokens).toBe(2);
  });

  test("assembles a tool call whose arguments arrive in fragments", async () => {
    server = serveChunks([
      sse(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "grep" } }] })),
      sse(delta({ tool_calls: [{ index: 0, function: { arguments: '{"pat' } }] })),
      sse(delta({ tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] })),
      sse(delta({}, "tool_calls")),
      sseDone(),
    ]);

    const events = await collect(provider(server.url).stream(baseRequest()));
    const end = lastEvent(events);

    expect(end.stopReason).toBe("tool_use");
    expect(end.message.content).toEqual([
      { type: "tool_use", id: "c1", name: "grep", input: { pattern: "x" } },
    ]);
    // The TUI is told the tool started as soon as the name is known.
    expect(events.some((e) => e.type === "tool_use_start" && e.name === "grep")).toBe(true);
  });

  test("infers tool_use when the server omits finish_reason", async () => {
    // llama.cpp and some proxies do this.
    server = serveChunks([
      sse(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "glob", arguments: "{}" } }] })),
      sseDone(),
    ]);
    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(end.stopReason).toBe("tool_use");
  });

  test("handles parallel tool calls", async () => {
    server = serveChunks([
      sse(delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"x"}' } }] })),
      sse(delta({ tool_calls: [{ index: 1, id: "b", function: { name: "glob", arguments: '{"pattern":"*"}' } }] })),
      sse(delta({}, "tool_calls")),
      sseDone(),
    ]);

    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(end.message.content.map((b) => (b.type === "tool_use" ? b.id : ""))).toEqual([
      "a",
      "b",
    ]);
  });

  test("streams reasoning_content as thinking without storing it in history", async () => {
    server = serveChunks([
      sse(delta({ reasoning_content: "let me think" })),
      sse(delta({ content: "answer" })),
      sse(delta({}, "stop")),
      sseDone(),
    ]);

    const events = await collect(provider(server.url).stream(baseRequest()));
    expect(thinkingOf(events)).toBe("let me think");
    // Reasoning cannot be round-tripped, so it must not enter the transcript.
    expect(lastEvent(events).message.content).toEqual([{ type: "text", text: "answer" }]);
  });

  test("subtracts cached tokens so the context meter totals correctly", async () => {
    server = serveChunks([
      sse(delta({ content: "x" }, "stop")),
      sse({
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
      sseDone(),
    ]);

    const { usage } = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(usage.inputTokens).toBe(200);
    expect(usage.cacheReadInputTokens).toBe(800);
    // input + cacheCreation + cacheRead === the real prompt size
    expect(usage.inputTokens + usage.cacheReadInputTokens).toBe(1000);
  });

  test("length finish maps to max_tokens", async () => {
    server = serveChunks([sse(delta({ content: "trunc" }, "length")), sseDone()]);
    expect(lastEvent(await collect(provider(server.url).stream(baseRequest()))).stopReason).toBe(
      "max_tokens",
    );
  });
});

describe("OpenAICompatibleProvider — request shape", () => {
  test("sends tools, system prompt, and max_completion_tokens when configured", async () => {
    server = serveChunks([sse(delta({ content: "ok" }, "stop")), sseDone()]);

    await collect(
      provider(server.url, { useMaxCompletionTokens: true }).stream(
        baseRequest({
          tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
        }),
      ),
    );

    const body = server.bodies[0]!;
    expect(body["max_completion_tokens"]).toBe(1024);
    expect(body["max_tokens"]).toBeUndefined();
    expect(body["stream"]).toBe(true);
    expect((body["messages"] as { role: string }[])[0]!.role).toBe("system");
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "bash", description: "run", parameters: { type: "object" } },
      },
    ]);
  });

  test("older compatible servers get max_tokens", async () => {
    server = serveChunks([sse(delta({ content: "ok" }, "stop")), sseDone()]);
    await collect(
      provider(server.url, { useMaxCompletionTokens: false }).stream(baseRequest()),
    );
    expect(server.bodies[0]!["max_tokens"]).toBe(1024);
  });

  test("reasoning_effort is opt-in, because chat models reject it", async () => {
    server = serveChunks([sse(delta({ content: "ok" }, "stop")), sseDone()]);
    await collect(provider(server.url).stream(baseRequest({ thinking: true })));
    expect(server.bodies[0]!["reasoning_effort"]).toBeUndefined();

    server.stop();
    server = serveChunks([sse(delta({ content: "ok" }, "stop")), sseDone()]);
    await collect(
      provider(server.url, { sendReasoningEffort: true }).stream(
        baseRequest({ thinking: true, effort: "xhigh" }),
      ),
    );
    expect(server.bodies[0]!["reasoning_effort"]).toBe("high");
  });
});

describe("OpenAICompatibleProvider — failure paths", () => {
  test("an HTTP error surfaces the server's message", async () => {
    server = serveChunks(['{"error":{"message":"model not found"}}'], 404);
    const req = baseRequest();
    await expect(collect(provider(server.url).stream(req))).rejects.toThrow(
      ProviderHttpError,
    );
    await expect(collect(provider(server!.url).stream(req))).rejects.toThrow(
      /model not found/,
    );
  });

  test("abort before any bytes yields an aborted turn, not a throw", async () => {
    server = serveHanging();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);

    const events = await collect(provider(server.url).stream(baseRequest({ signal: ac.signal })));
    const end = lastEvent(events);
    expect(end.stopReason).toBe("aborted");
    expect(end.message.content).toEqual([]);
  });

  test("a partial answer is salvaged when the user aborts mid-stream", async () => {
    server = serveChunksThenHang([sse(delta({ content: "partial" }))]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);

    const events = await collect(provider(server.url).stream(baseRequest({ signal: ac.signal })));
    const end = lastEvent(events);

    expect(textOf(events)).toBe("partial");
    expect(end.stopReason).toBe("aborted");
    // No dangling tool_use: it would make the next request a 400.
    expect(end.message.content).toEqual([{ type: "text", text: "partial" }]);
  });

  test("malformed tool arguments reach the model rather than crashing", async () => {
    server = serveChunks([
      sse(delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: "{not json" } }] })),
      sse(delta({}, "tool_calls")),
      sseDone(),
    ]);
    const end = lastEvent(await collect(provider(server.url).stream(baseRequest())));
    expect(end.message.content[0]).toMatchObject({
      type: "tool_use",
      input: { __malformed_arguments__: "{not json" },
    });
  });
});

describe("toChatMessages", () => {
  test("assistant tool_use becomes tool_calls with stringified arguments", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "out", is_error: false }],
      },
    ];

    expect(toChatMessages(messages)).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "running",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "out" },
    ]);
  });

  test("parallel tool results each become their own tool message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "1", is_error: false },
          { type: "tool_result", tool_use_id: "b", content: "2", is_error: true },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "2" },
    ]);
  });

  test("thinking blocks are dropped — no provider here can round-trip a signature", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([{ role: "assistant", content: "answer" }]);
  });

  test("a tool-only assistant turn sends null content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "glob", input: {} }],
      },
    ];
    expect(toChatMessages(messages)[0]).toMatchObject({ role: "assistant", content: null });
  });
});

describe("mapping helpers", () => {
  test("finish_reason", () => {
    expect(mapFinish("tool_calls")).toBe("tool_use");
    expect(mapFinish("length")).toBe("max_tokens");
    expect(mapFinish("content_filter")).toBe("refusal");
    expect(mapFinish("stop")).toBe("end_turn");
    expect(mapFinish(null)).toBe("end_turn");
  });

  test("effort collapses onto OpenAI's three levels", () => {
    expect(mapEffort("low")).toBe("low");
    expect(mapEffort("medium")).toBe("medium");
    expect(mapEffort("xhigh")).toBe("high");
    expect(mapEffort("max")).toBe("high");
  });
});
