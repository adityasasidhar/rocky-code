import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "../config/schema.ts";
import { applyWorkspacePatch, inspectPatch, undoWorkspacePatch } from "../workspace/patch.ts";
import { loadSnapshot } from "../workspace/snapshot.ts";
import { WorkerBroker } from "./broker.ts";

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const TOOLS = [
  {
    name: "worker_list",
    description: "List configured disposable coding workers, live availability, authentication health, and recent outcomes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "worker_recommend",
    description: "Rank eligible workers for a coding task using capability tags and recent health.",
    inputSchema: {
      type: "object",
      properties: { capabilities: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "worker_start",
    description: "Start a coding worker asynchronously inside a hardened container against an immutable workspace snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        worker: { type: "string" },
        snapshotId: { type: "string", pattern: "^[a-f0-9]{24}$" },
        taskId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,64}$" },
        prompt: { type: "string", minLength: 1 },
      },
      required: ["worker", "snapshotId", "taskId", "prompt"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "worker_status",
    description: "Read normalized progress events and status for a worker run.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "worker_result",
    description: "Get the candidate patch, redacted logs, verification claim, and exit classification from a completed worker.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "worker_cancel",
    description: "Terminate a worker container and its descendants.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "workspace_apply_patch",
    description: "After TrueForge human approval, conflict-check and atomically apply a validated candidate patch to the real workspace with a checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotId: { type: "string", pattern: "^[a-f0-9]{24}$" },
        patch: { type: "string", minLength: 1 },
      },
      required: ["snapshotId", "patch"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "workspace_undo",
    description: "After TrueForge human approval, restore the last Rocky checkpoint if no later edits conflict.",
    inputSchema: {
      type: "object",
      properties: { checkpointId: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
] as const;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("arguments must be an object");
  return value as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function result(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
  };
}

export function brokerToken(root: string, config: Config): string {
  const fromEnv = process.env[config.broker.tokenEnv];
  if (fromEnv) return fromEnv;
  const dir = join(root, ".rocky", "broker");
  const path = join(dir, "token");
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();
    if (stored.length >= 32) {
      chmodSync(path, 0o600);
      return stored;
    }
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

async function callTool(broker: WorkerBroker, name: string, rawArgs: unknown): Promise<Record<string, unknown>> {
  const args = object(rawArgs ?? {});
  switch (name) {
    case "worker_list":
      return result(broker.listWorkers());
    case "worker_recommend": {
      const value = args["capabilities"];
      const capabilities = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      return result(broker.recommend(capabilities));
    }
    case "worker_start":
      return result(
        broker.start(
          requiredString(args, "worker"),
          requiredString(args, "snapshotId"),
          requiredString(args, "taskId"),
          requiredString(args, "prompt"),
        ),
      );
    case "worker_status":
      return result(broker.status(requiredString(args, "runId")));
    case "worker_result":
      return result(broker.result(requiredString(args, "runId")));
    case "worker_cancel":
      return result(broker.cancel(requiredString(args, "runId")));
    case "workspace_apply_patch": {
      const snapshot = loadSnapshot(broker.root, requiredString(args, "snapshotId"));
      const patch = requiredString(args, "patch");
      const summary = inspectPatch(patch);
      return result({ ...applyWorkspacePatch(broker.root, snapshot, patch, true), summary });
    }
    case "workspace_undo": {
      const checkpointId = typeof args["checkpointId"] === "string" ? args["checkpointId"] : undefined;
      return result(undoWorkspacePatch(broker.root, true, checkpointId));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function dispatch(broker: WorkerBroker, request: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
  const id = request.id ?? null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid JSON-RPC request" } };
  }
  if (request.method.startsWith("notifications/")) return undefined;
  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "rocky-worker-broker", version: "0.1.0" },
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call": {
        const params = object(request.params);
        const name = requiredString(params, "name");
        const output = await callTool(broker, name, params["arguments"]);
        return { jsonrpc: "2.0", id, result: output };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${request.method}` } };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      result: result(error instanceof Error ? error.message : String(error), true),
    };
  }
}

export interface BrokerServer {
  url: string;
  token: string;
  stop(): void;
}

/** Reuse an authenticated standalone broker, otherwise start one in-process. */
export async function ensureBrokerServer(root: string, config: Config): Promise<BrokerServer> {
  const token = brokerToken(root, config);
  const url = `http://${config.broker.host}:${config.broker.port}/mcp`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rocky-probe", method: "ping" }),
      signal: AbortSignal.timeout(500),
    });
    const body = (await response.json()) as { result?: unknown };
    if (response.ok && body.result !== undefined) {
      return { url, token, stop() {} };
    }
  } catch {
    // No authenticated broker is listening; start the project-owned instance.
  }
  return startBrokerServer(root, config);
}

export function startBrokerServer(root: string, config: Config): BrokerServer {
  const broker = new WorkerBroker(root, config);
  const token = brokerToken(root, config);
  const server = Bun.serve({
    hostname: config.broker.host,
    port: config.broker.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return Response.json({ ok: true, workers: broker.listWorkers().length });
      if (url.pathname !== "/mcp" || request.method !== "POST") return new Response("Not found", { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
      let body: JsonRpcRequest | JsonRpcRequest[];
      try {
        body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      const requests = Array.isArray(body) ? body : [body];
      const responses = (await Promise.all(requests.map((item) => dispatch(broker, item)))).filter(
        (item): item is Record<string, unknown> => item !== undefined,
      );
      if (responses.length === 0) return new Response(null, { status: 202 });
      const responseBody = Array.isArray(body) ? responses : responses[0];
      return Response.json(responseBody, { headers: { "mcp-session-id": randomBytes(12).toString("hex") } });
    },
  });
  return {
    url: `http://${config.broker.host}:${server.port}/mcp`,
    token,
    stop() {
      server.stop(true);
      broker.close();
    },
  };
}
