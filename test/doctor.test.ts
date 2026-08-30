import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigSchema } from "../src/config/schema.ts";
import { doctor } from "../src/doctor.ts";
import { cleanup, tempDir } from "./helpers.ts";

/**
 * A stub TrueForge that answers only the two endpoints `doctor` reaches for.
 * `sandbox` mirrors the real server: 404 with an error body when no provider is
 * configured, 200 with the provider manifest when one is.
 */
function stubTrueForge(
  sandbox: "configured" | "missing",
  sandboxStatus: "ready" | "pending" = "ready",
): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") return new Response("OK!");
      if (pathname === "/api/v1/settings/sandbox-providers") {
        return sandbox === "configured"
          ? Response.json({
              data: {
                manifest: { type: "daytona", exec_timeout_ms: 60_000 },
                status: sandboxStatus,
                status_reason: sandboxStatus === "ready" ? null : "Sandbox image build in progress.",
              },
            })
          : Response.json({ error: { message: "No sandbox provider configured" } }, { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function configFor(baseUrl: string, sandbox: boolean) {
  return ConfigSchema.parse({
    backend: "trueforge",
    trueforge: { baseUrl, model: "openai/gpt-5-4-mini", sandbox },
  });
}

const sandboxCheck = (checks: Awaited<ReturnType<typeof doctor>>) =>
  checks.find((check) => check.name === "Daytona sandbox");

describe("doctor · Daytona sandbox", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir();
  });
  afterEach(() => cleanup(root));

  test("passes when TrueForge reports a configured sandbox provider", async () => {
    const server = stubTrueForge("configured");
    try {
      const check = sandboxCheck(await doctor(root, configFor(server.url, true)));
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("daytona");
    } finally {
      server.stop();
    }
  });

  // The bug this replaced: the check echoed `trueforge.sandbox` back, so it went
  // green here and the first snapshot-carrying turn died on a bare 500 instead.
  test("fails when the agent spec asks for a sandbox TrueForge cannot provide", async () => {
    const server = stubTrueForge("missing");
    try {
      const check = sandboxCheck(await doctor(root, configFor(server.url, true)));
      expect(check?.ok).toBe(false);
      expect(check?.required).toBe(true);
      expect(check?.detail).toContain("Sandbox providers");
    } finally {
      server.stop();
    }
  });

  test("is neither failing nor required when the spec disables the sandbox", async () => {
    const server = stubTrueForge("missing");
    try {
      const check = sandboxCheck(await doctor(root, configFor(server.url, false)));
      expect(check?.ok).toBe(true);
      expect(check?.required).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("does not claim a sandbox is missing when TrueForge is simply unreachable", async () => {
    // Port 1 is reserved and refuses immediately, so this stays fast.
    const check = sandboxCheck(await doctor(root, configFor("http://127.0.0.1:1", true)));
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("unreachable");
  });
});

describe("doctor · Daytona sandbox image build", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir();
  });
  afterEach(() => cleanup(root));

  // A stored key is not a usable sandbox. Passing here would put the demo back
  // where it started: a green preflight, then a turn that dies on the attach.
  test("fails while the sandbox image is still building", async () => {
    const server = stubTrueForge("configured", "pending");
    try {
      const check = sandboxCheck(await doctor(root, configFor(server.url, true)));
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("pending");
    } finally {
      server.stop();
    }
  });

  test("names the provider type once the image is ready", async () => {
    const server = stubTrueForge("configured", "ready");
    try {
      const check = sandboxCheck(await doctor(root, configFor(server.url, true)));
      expect(check?.ok).toBe(true);
      expect(check?.detail).toBe("daytona · image ready");
    } finally {
      server.stop();
    }
  });
});
