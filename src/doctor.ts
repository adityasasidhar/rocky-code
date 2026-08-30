import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBaseUrl, type Config } from "./config/schema.ts";
import { resolveApiKey } from "./config/credentials.ts";
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

/**
 * A sandbox the agent spec merely *requests* is not a sandbox TrueForge can
 * provide. Reporting `config.trueforge.sandbox` back to the user was a check
 * that could not fail: it went green while `GET /settings/sandbox-providers`
 * answered 404, and the first turn carrying a workspace snapshot then died on
 * an opaque 500 (TrueForge returns a clean 422 only when the spec disables the
 * sandbox). Ask the server instead.
 */
async function sandboxProvider(
  config: Config,
  headers: Record<string, string> | undefined,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(
      new URL("/api/v1/settings/sandbox-providers", config.trueforge.baseUrl).toString(),
      { headers, signal: AbortSignal.timeout(3_000) },
    );
    if (response.status === 404) {
      return {
        ok: false,
        detail: "no sandbox provider configured — add a Daytona API key in TrueForge Settings → Sandbox providers",
      };
    }
    if (!response.ok) return { ok: false, detail: `${response.status} ${response.statusText}`.trim() };
    // A stored key is not yet a usable sandbox: TrueForge builds the sandbox
    // image on save, and a turn cannot run until that reaches `ready`.
    const body = (await response.json()) as {
      data?: { manifest?: { type?: unknown }; status?: unknown; status_reason?: unknown };
    };
    const type =
      typeof body.data?.manifest?.type === "string" ? body.data.manifest.type : "sandbox provider";
    const status = typeof body.data?.status === "string" ? body.data.status : "unknown";
    const reason = typeof body.data?.status_reason === "string" ? body.data.status_reason : "";
    return status === "ready"
      ? { ok: true, detail: `${type} · image ready` }
      : { ok: false, detail: `${type} · image ${status}${reason ? ` — ${reason}` : ""}` };
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
    ...(!config.trueforge.sandbox
      ? { ok: true, detail: "disabled in the TrueForge agent spec" }
      : trueforge.ok
        ? await sandboxProvider(
            config,
            trueForgeToken ? { authorization: `Bearer ${trueForgeToken}` } : undefined,
          )
        : { ok: false, detail: "requested, but TrueForge is unreachable" }),
    // A snapshot-carrying turn cannot run without it, so this is fatal exactly
    // when the agent spec asks for a sandbox.
    required: config.backend === "trueforge" && config.trueforge.sandbox,
  });

  // The provider only drives the local loop, so a missing key is required-fatal
  // there and merely worth reporting under TrueForge. Presence only — the value
  // is never read into the output.
  const key = resolveApiKey(config.provider, { name: config.activeProvider });
  const providerLabel = config.activeProvider
    ? `${config.activeProvider} · ${config.provider.kind}`
    : config.provider.kind;
  const endpointLabel =
    config.provider.baseUrl ?? defaultBaseUrl(config.provider.kind) ?? "sdk default";
  checks.push({
    name: "provider",
    ok: true,
    detail: `${providerLabel} · ${config.model} · ${endpointLabel}`,
    required: false,
  });
  checks.push({
    name: "provider credentials",
    ok: config.provider.kind === "ollama" || key.source !== "none",
    detail:
      config.provider.kind === "ollama"
        ? "no auth required"
        : key.source === "env"
          ? `${key.envVar} is set`
          : key.source === "stored"
            ? "key stored by /provider add"
            : `no key — set ${key.envVar ?? "an env var"} or run /provider add`,
    required: config.backend === "local",
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
