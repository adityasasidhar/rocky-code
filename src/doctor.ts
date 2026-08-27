import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config/schema.ts";
import { createWorkspaceSnapshot } from "./workspace/snapshot.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

function command(args: string[], cwd: string): { ok: boolean; detail: string } {
  try {
    const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    return {
      ok: result.exitCode === 0,
      detail: (result.stdout.toString() || result.stderr.toString()).trim().split("\n", 1)[0] ?? "",
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function endpoint(url: string, headers?: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
    return { ok: response.ok, detail: `${response.status} ${response.statusText}`.trim() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function doctor(root: string, config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const trueForgeToken = process.env[config.trueforge.tokenEnv];
  const trueforge = await endpoint(
    new URL("/healthz", config.trueforge.baseUrl).toString(),
    trueForgeToken ? { authorization: `Bearer ${trueForgeToken}` } : undefined,
  );
  checks.push({ name: "TrueForge", ...trueforge, required: config.backend === "trueforge" });
  checks.push({
    name: "root model",
    ok: Boolean(config.trueforge.model || config.model),
    detail: config.trueforge.model ?? config.model,
    required: true,
  });
  checks.push({
    name: "Daytona sandbox",
    ok: config.trueforge.sandbox,
    detail: config.trueforge.sandbox ? "enabled in the TrueForge agent spec" : "disabled",
    required: config.backend === "trueforge",
  });

  const docker = command(["docker", "version", "--format", "{{.Server.Version}}"], root);
  checks.push({ name: "Docker", ...docker, required: Object.values(config.broker.workers).some((worker) => worker.enabled) });
  for (const [name, worker] of Object.entries(config.broker.workers)) {
    if (!worker.enabled) continue;
    const image = command(["docker", "image", "inspect", "--format", "{{.Id}}", worker.image], root);
    checks.push({ name: `worker ${name}`, ...image, detail: image.ok ? `${worker.kind} · ${worker.image}` : image.detail, required: true });
    const missing = worker.credentialEnv.filter((key) => !process.env[key]);
    checks.push({
      name: `${name} credentials`,
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${worker.credentialEnv.length} required variable(s) present` : `missing ${missing.join(", ")}`,
      required: true,
    });
  }

  const tokenPath = join(root, ".rocky", "broker", "token");
  const token = process.env[config.broker.tokenEnv] ??
    (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : undefined);
  const broker = token
    ? await (async () => {
        try {
          const response = await fetch(`http://${config.broker.host}:${config.broker.port}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "ping" }),
            signal: AbortSignal.timeout(3_000),
          });
          const body = (await response.json()) as { result?: unknown };
          return {
            ok: response.ok && body.result !== undefined,
            detail: response.ok && body.result !== undefined ? "authenticated MCP ping succeeded" : `${response.status} ${response.statusText}`,
          };
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      })()
    : { ok: false, detail: "bearer token is not configured" };
  checks.push({
    name: "worker broker",
    ...broker,
    detail: `${broker.detail}${token ? " · bearer token configured" : ""}`,
    required: config.backend === "trueforge",
  });

  const git = command(["git", "rev-parse", "--show-toplevel"], root);
  checks.push({ name: "Git workspace", ...git, required: true });
  try {
    const snapshot = createWorkspaceSnapshot(root, {
      maxBytes: config.broker.maxSnapshotBytes,
      secretPatterns: config.broker.secretPatterns,
      persist: false,
    });
    checks.push({
      name: "snapshot safety",
      ok: true,
      detail: `${snapshot.files.length} files · ${(snapshot.totalBytes / 1024 / 1024).toFixed(1)} MiB · secrets excluded`,
      required: true,
    });
  } catch (error) {
    checks.push({
      name: "snapshot safety",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      required: true,
    });
  }
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? "✓" : check.required ? "✗" : "!"} ${check.name.padEnd(20)} ${check.detail}`)
    .join("\n");
}
