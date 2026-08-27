import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config, WorkerProfile } from "../config/schema.ts";
import { extractSnapshot, loadSnapshot } from "../workspace/snapshot.ts";
import { inspectPatch } from "../workspace/patch.ts";
import { adapterFor } from "./adapters.ts";
import { assertRecoveryAllowed, classifyFailure, recommendWorkers } from "./recovery.ts";
import type {
  WorkerEvent,
  WorkerHealth,
  WorkerRecommendation,
  WorkerRun,
} from "./types.ts";

const RUN_ID = /^[0-9a-f-]{36}$/i;
const SNAPSHOT_ID = /^[a-f0-9]{24}$/;
const TASK_ID = /^[A-Za-z0-9_-]{8,64}$/;

type RunningProcess = {
  kill(): void;
  containerName: string;
};

function runCommand(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error("invalid run id");
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length >= 6) output = output.replaceAll(secret, "[REDACTED]");
  }
  return output
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function decodeRun(row: { data: string } | null): WorkerRun | undefined {
  return row ? (JSON.parse(row.data) as WorkerRun) : undefined;
}

export class WorkerBroker {
  readonly root: string;
  readonly config: Config;
  private readonly db: Database;
  private readonly running = new Map<string, RunningProcess>();

  constructor(rootInput: string, config: Config) {
    this.root = resolve(rootInput);
    this.config = config;
    const dir = join(this.root, ".rocky", "broker");
    mkdirSync(join(dir, "runs"), { recursive: true });
    this.db = new Database(join(dir, "runs.db"), { create: true, strict: true });
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, worker TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS runs_worker_started ON runs(worker, started_at DESC);",
    );
  }

  close(): void {
    this.db.close();
  }

  private save(run: WorkerRun): void {
    this.db
      .query(
        "INSERT INTO runs(id, worker, status, started_at, data) VALUES(?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data",
      )
      .run(run.id, run.worker, run.status, run.startedAt, JSON.stringify(run));
  }

  private profile(name: string): WorkerProfile {
    const profile = this.config.broker.workers[name];
    if (!profile) throw new Error(`unknown worker: ${name}`);
    if (!profile.enabled) throw new Error(`worker is disabled: ${name}`);
    return profile;
  }

  getRun(id: string): WorkerRun | undefined {
    assertRunId(id);
    return decodeRun(this.db.query<{ data: string }, [string]>("SELECT data FROM runs WHERE id=?1").get(id));
  }

  listWorkers(): WorkerHealth[] {
    return Object.entries(this.config.broker.workers).map(([name, profile]) => {
      const image = runCommand(["docker", "image", "inspect", profile.image], this.root);
      const running = [...this.running.values()].filter((value) => value.containerName.startsWith(`rocky-${name}-`)).length;
      const recentRuns = this.db
        .query<{ data: string }, [string]>(
          "SELECT data FROM runs WHERE worker=?1 ORDER BY started_at DESC LIMIT 20",
        )
        .all(name)
        .map((row) => JSON.parse(row.data) as WorkerRun);
      const settledRuns = recentRuns.filter((run) => run.status !== "queued" && run.status !== "running");
      const elapsed = recentRuns
        .map((run) => run.elapsedMs)
        .filter((value): value is number => value !== undefined);
      const required = profile.credentialEnv;
      const authenticated = required.every((key) => Boolean(process.env[key]));
      return {
        name,
        kind: profile.kind,
        enabled: profile.enabled,
        image: profile.image,
        version: profile.image.includes(":") ? (profile.image.split(":").at(-1) ?? profile.image) : profile.image,
        ...(profile.model ? { model: profile.model } : {}),
        capabilities: profile.capabilities,
        available: image.code === 0,
        authenticated,
        recentSuccessRate:
          settledRuns.length > 0
            ? settledRuns.filter((run) => run.status === "completed" && !run.adapterFallbacks).length /
              settledRuns.length
            : 0.5,
        ...(elapsed.length > 0
          ? { averageLatencyMs: elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length }
          : {}),
        costTier: profile.costTier,
        running,
        concurrency: profile.concurrency,
        ...(image.code === 0 ? {} : { reason: image.stderr.trim() || "container image not found" }),
      };
    });
  }

  recommend(capabilities: readonly string[] = []): WorkerRecommendation[] {
    return recommendWorkers(this.listWorkers(), capabilities);
  }

  start(worker: string, snapshotId: string, taskId: string, prompt: string): WorkerRun {
    const profile = this.profile(worker);
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error("invalid snapshot id");
    if (!TASK_ID.test(taskId)) throw new Error("invalid task id");
    const taskAttempts = this.db
      .query<{ data: string }, []>("SELECT data FROM runs")
      .all()
      .map((row) => JSON.parse(row.data) as Partial<WorkerRun>)
      .filter((run) => run.taskId === taskId).length;
    assertRecoveryAllowed(taskId, taskAttempts, this.config.broker.maxRecoveryAttempts);
    const health = this.listWorkers().find((value) => value.name === worker);
    if (!health?.available) throw new Error(health?.reason ?? `worker image unavailable: ${profile.image}`);
    if (!health.authenticated) throw new Error(`worker credentials unavailable: set ${profile.credentialEnv.join(", ")}`);
    if (health.running >= profile.concurrency) throw new Error(`worker concurrency limit reached: ${worker}`);

    const run: WorkerRun = {
      id: randomUUID(),
      taskId,
      worker,
      snapshotId,
      prompt,
      status: "queued",
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.save(run);
    void this.execute(run, profile);
    return run;
  }

  private append(run: WorkerRun, event: WorkerEvent): void {
    if (event.rawType === "plain-text-fallback") {
      run.adapterFallbacks = (run.adapterFallbacks ?? 0) + 1;
    }
    run.events.push(event);
    if (run.events.length > 2_000) run.events.splice(0, run.events.length - 2_000);
    this.save(run);
  }

  private async readEvents(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let all = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      all += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    pending += decoder.decode();
    if (pending) onLine(pending);
    return all;
  }

  private initializeWorkspace(runDir: string, snapshotId: string): string {
    const snapshot = loadSnapshot(this.root, snapshotId);
    const workspace = join(runDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    extractSnapshot(snapshot.archive, workspace);
    const init = runCommand(["git", "init", "--quiet"], workspace);
    if (init.code !== 0) throw new Error(init.stderr);
    runCommand(["git", "config", "user.email", "rocky@localhost"], workspace);
    runCommand(["git", "config", "user.name", "Rocky Worker"], workspace);
    runCommand(["git", "add", "-A"], workspace);
    const commit = runCommand(
      ["git", "commit", "--quiet", "--allow-empty", "-m", "snapshot baseline"],
      workspace,
    );
    if (commit.code !== 0) throw new Error(`could not create worker baseline: ${commit.stderr}`);
    return workspace;
  }

  private dockerArgs(
    run: WorkerRun,
    profile: WorkerProfile,
    workspace: string,
  ): { args: string[]; secrets: string[] } {
    const adapter = adapterFor(profile.kind);
    const invocation = adapter.invocation(profile, run.prompt);
    const containerName = `rocky-${run.worker}-${run.id.slice(0, 8)}`;
    const args = [
      "docker",
      "run",
      "--rm",
      "--name",
      containerName,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m",
      ...(typeof process.getuid === "function" && process.getuid() !== 0
        ? ["--user", `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`]
        : []),
      "--env",
      "HOME=/tmp/rocky-home",
      "--volume",
      `${workspace}:/workspace:rw`,
      "--workdir",
      "/workspace",
    ];
    const secrets: string[] = [];
    for (const [key, value] of Object.entries(invocation.env)) args.push("--env", `${key}=${value}`);
    for (const key of profile.credentialEnv) {
      const value = process.env[key];
      if (!value) continue;
      secrets.push(value);
      // Docker reads the inherited value; the credential never appears in argv.
      args.push("--env", key);
    }
    args.push(profile.image, ...invocation.command);
    return { args, secrets };
  }

  private async execute(run: WorkerRun, profile: WorkerProfile): Promise<void> {
    const runDir = join(this.root, ".rocky", "broker", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    const started = Date.now();
    let timedOut = false;
    try {
      const workspace = this.initializeWorkspace(runDir, run.snapshotId);
      const { args, secrets } = this.dockerArgs(run, profile, workspace);
      const adapter = adapterFor(profile.kind);
      const containerName = `rocky-${run.worker}-${run.id.slice(0, 8)}`;
      run.status = "running";
      this.append(run, { type: "started", at: new Date().toISOString(), text: `container ${containerName}` });
      const subprocess = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      this.running.set(run.id, { kill: () => subprocess.kill(), containerName });
      const timer = setTimeout(() => {
        timedOut = true;
        subprocess.kill();
        runCommand(["docker", "rm", "-f", containerName], this.root);
      }, profile.timeoutMs);

      const stdoutPromise = this.readEvents(subprocess.stdout, (line) => {
        const parsed = adapter.parseLine(redact(line, secrets));
        if (parsed) this.append(run, parsed);
      });
      const stderrPromise = new Response(subprocess.stderr).text();
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      const exitCode = await subprocess.exited;
      clearTimeout(timer);
      this.running.delete(run.id);
      const logs = redact(`${stdout}${stderr ? `\n${stderr}` : ""}`, secrets).slice(-100_000);
      run.logs = logs;
      run.exitCode = exitCode;

      if (timedOut) throw new Error(`worker timed out after ${profile.timeoutMs}ms`);
      if (exitCode !== 0) throw new Error(stderr.trim() || `worker exited ${exitCode}`);
      const adapterFailure = [...run.events].reverse().find((event) => event.type === "failed");
      if (adapterFailure) throw new Error(adapterFailure.text ?? "worker reported failure");
      runCommand(["git", "add", "-N", "."], workspace);
      const diff = runCommand(["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--", "."], workspace);
      if (diff.code !== 0) throw new Error(`could not collect candidate patch: ${diff.stderr}`);
      if (!diff.stdout.trim()) throw new Error("worker completed without producing a patch");
      inspectPatch(diff.stdout);
      run.patch = diff.stdout;
      run.summary = [...run.events].reverse().find((value) => value.type === "message")?.text ?? "candidate patch generated";
      run.verificationClaim = [...run.events].reverse().find((value) => value.type === "completed")?.text;
      run.status = "completed";
      run.exitClass = "success";
      this.append(run, { type: "completed", at: new Date().toISOString(), text: run.summary });
    } catch (error) {
      this.running.delete(run.id);
      const message = error instanceof Error ? error.message : String(error);
      if (run.status !== "cancelled") {
        run.status = "failed";
        run.exitClass = timedOut ? "timeout" : classifyFailure(message, run.exitCode);
      }
      run.summary = message;
      this.append(run, { type: "failed", at: new Date().toISOString(), text: message });
    } finally {
      run.completedAt = new Date().toISOString();
      run.elapsedMs = Date.now() - started;
      run.resourceUsage = { elapsedMs: run.elapsedMs };
      this.save(run);
    }
  }

  status(id: string): WorkerRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`run not found: ${id}`);
    const elapsedMs = run.completedAt
      ? run.elapsedMs
      : Math.max(0, Date.now() - Date.parse(run.startedAt));
    const process = this.running.get(id);
    let resourceUsage: WorkerRun["resourceUsage"] = { elapsedMs: elapsedMs ?? 0 };
    if (process) {
      const stats = runCommand(
        ["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}", process.containerName],
        this.root,
      );
      if (stats.code === 0) {
        const [cpuPercent, memoryUsage, rawPids] = stats.stdout.trim().split("\t");
        const pids = Number(rawPids);
        resourceUsage = {
          elapsedMs: elapsedMs ?? 0,
          ...(cpuPercent ? { cpuPercent } : {}),
          ...(memoryUsage ? { memoryUsage } : {}),
          ...(Number.isFinite(pids) ? { pids } : {}),
        };
      }
    }
    return { ...run, elapsedMs, resourceUsage, patch: undefined, logs: undefined };
  }

  result(id: string): WorkerRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`run not found: ${id}`);
    return run;
  }

  cancel(id: string): WorkerRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`run not found: ${id}`);
    const process = this.running.get(id);
    if (process) {
      process.kill();
      runCommand(["docker", "rm", "-f", process.containerName], this.root);
      this.running.delete(id);
    }
    run.status = "cancelled";
    run.exitClass = "cancelled";
    run.completedAt = new Date().toISOString();
    this.append(run, { type: "failed", at: new Date().toISOString(), text: "cancelled" });
    return run;
  }

  purgeRun(id: string): void {
    assertRunId(id);
    if (this.running.has(id)) throw new Error("cannot purge a running worker");
    this.db.query("DELETE FROM runs WHERE id=?1").run(id);
    rmSync(join(this.root, ".rocky", "broker", "runs", id), { recursive: true, force: true });
  }

  snapshotManifest(id: string): string {
    if (!SNAPSHOT_ID.test(id)) throw new Error("invalid snapshot id");
    return readFileSync(join(this.root, ".rocky", "snapshots", `${id}.json`), "utf8");
  }
}
