import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureBrokerServer,
  startBrokerServer,
  type BrokerServer,
} from "../../src/broker/server.ts";
import { defaultConfig, type Config } from "../../src/config/schema.ts";
import { createWorkspaceSnapshot } from "../../src/workspace/snapshot.ts";
import { cleanup, tempDir } from "../helpers.ts";

let dir: string;
let server: BrokerServer | undefined;
beforeEach(() => (dir = tempDir()));
afterEach(() => {
  server?.stop();
  server = undefined;
  cleanup(dir);
});

function config(): Config {
  const base = defaultConfig();
  return { ...base, broker: { ...base.broker, port: 0, tokenEnv: "ROCKY_TEST_BROKER_TOKEN" } };
}

async function rpc(token: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(server!.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("Streamable HTTP worker broker", () => {
  test("binds locally, requires its bearer token, and advertises all tools", async () => {
    server = startBrokerServer(dir, config());
    expect(server.url).toStartWith("http://127.0.0.1:");
    expect((await fetch(server.url, { method: "POST" })).status).toBe(401);
    const initialized = await rpc(server.token, "initialize");
    expect(initialized["result"]).toBeObject();
    const listed = await rpc(server.token, "tools/list");
    const result = listed["result"] as {
      tools: { name: string; inputSchema?: { required?: string[] } }[];
    };
    expect(result.tools.map((tool) => tool.name)).toContain("workspace_apply_patch");
    expect(result.tools.map((tool) => tool.name)).toContain("worker_recommend");
    expect(
      result.tools.find((tool) => tool.name === "worker_start")?.inputSchema?.required,
    ).toContain("taskId");
  });

  test("reuses an authenticated standalone broker instead of colliding on its port", async () => {
    const initial = config();
    server = startBrokerServer(dir, initial);
    const fixedPort = Number(new URL(server.url).port);
    const reused = await ensureBrokerServer(dir, {
      ...initial,
      broker: { ...initial.broker, port: fixedPort },
    });
    expect(reused.url).toBe(server.url);
    expect(reused.token).toBe(server.token);
    reused.stop();
    expect((await fetch(server.url.replace("/mcp", "/healthz"))).ok).toBe(true);
  });

  test("applies a hash-checked patch through the authenticated destructive tool", async () => {
    writeFileSync(join(dir, "a.txt"), "before\n");
    Bun.spawnSync(["git", "-C", dir, "init", "--quiet"]);
    const snapshot = createWorkspaceSnapshot(dir);
    server = startBrokerServer(dir, config());
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n";
    const response = await rpc(server.token, "tools/call", {
      name: "workspace_apply_patch",
      arguments: { snapshotId: snapshot.id, patch },
    });
    const callResult = response["result"] as { isError: boolean };
    expect(callResult.isError).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("after\n");
  });
});
