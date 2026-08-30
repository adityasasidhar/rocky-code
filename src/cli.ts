#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LocalBackend,
  TrueForgeBackend,
  type AgentBackend,
  type BackendApprovalRequest,
} from "./backend/index.ts";
import { ensureBrokerServer, startBrokerServer, type BrokerServer } from "./broker/server.ts";
import { WorkerBroker } from "./broker/broker.ts";
import { ConfigError, loadConfig } from "./config/load.ts";
import type { Config, PermissionMode } from "./config/schema.ts";
import type { LoopEvent } from "./core/loop.ts";
import { loadProjectMemory } from "./core/memory.ts";
import { PLAN_MODE_PROMPT } from "./core/prompt.ts";
import { ProviderConfigError } from "./core/provider/index.ts";
import { providerFor } from "./core/provider_registry.ts";
import {
  awaitingProviderAnswer,
  awaitingSecret,
  runProviderCommand,
  runProviderWizardLine,
  type ProviderCommandCtx,
} from "./core/provider_command.ts";
import { runConnect, runModels } from "./core/connect_command.ts";
import type { Wizard } from "./config/providers.ts";
import { Session } from "./core/session.ts";
import { DEFAULT_CONTEXT_WINDOW, type Provider } from "./core/types.ts";
import { footerAsk, nonInteractiveAsk, PermissionEngine, ttyAsk } from "./permissions/index.ts";
import { makeRegistry } from "./tools/index.ts";
import { compactSession } from "./core/compact.ts";
import {
  bold,
  compactNumber,
  cyan,
  dim,
  gray,
  green,
  magenta,
  meter,
  red,
  stripAnsi,
  yellow,
} from "./tui/ansi.ts";
import { banner } from "./tui/banner.ts";
import {
  HISTORY_LIMIT,
  parseHistory,
  serializeHistory,
  advertisedCommands,
  splitTypeAhead,
  unknownCommand,
} from "./tui/input.ts";
import { watchKeys, type KeyWatcher } from "./tui/keys.ts";
import { Renderer, ToolLog } from "./tui/render.ts";
import { Scrollback } from "./tui/scrollback.ts";
import { StatusBar } from "./tui/status.ts";
import { Editor } from "./tui/editor.ts";
import { setTheme } from "./tui/theme.ts";
import { doctor, formatDoctor } from "./doctor.ts";
import { undoWorkspacePatch } from "./workspace/patch.ts";
import pkg from "../package.json";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_CONFIG = 2;
const EXIT_INTERRUPTED = 130;

/** Session accounting without coupling the TrueForge backend to a legacy provider client. */
function trueForgeAccountingProvider(config: Config): Provider {
  return {
    name: "TrueForge",
    contextWindow: () => config.provider.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    pricing: () => config.provider.pricing ?? { input: 0, output: 0 },
    async *stream() {
      throw new Error("the TrueForge backend owns model streaming");
    },
  };
}

const HELP = `${bold("rocky")} — a terminal coding agent

${bold("USAGE")}
  rocky                    start an interactive session
  rocky -p "<prompt>"      run one prompt, print the answer, exit
  rocky doctor             verify TrueForge, Daytona, broker, Docker, workers, and workspace safety
  rocky broker             run the localhost MCP worker broker
  rocky providers          list credentials and environment-supplied providers
  rocky providers login    register a provider from the models.dev catalog
  rocky providers logout <id>   forget a provider and its stored key
  rocky models [provider]  list every model in the catalog as provider/model

${bold("OPTIONS")}
  -p, --print <prompt>       non-interactive; answer to stdout, trace to stderr
      --model <id>           model to use (default: claude-opus-4-8)
      --backend <kind>       trueforge (default) | local
      --provider <kind>      anthropic | openai | openai-compatible | minimax | ollama
      --base-url <url>       provider endpoint override
      --effort <level>       low | medium | high | xhigh | max
      --cwd <dir>            working directory (default: .)
      --no-thinking          disable extended thinking

${bold("PERMISSIONS")}
      --permission-mode <m>  ask (default) | auto-edit | yolo | plan
      --yolo                 shorthand for --permission-mode yolo
      --allow <rule>         allow a command prefix, repeatable ("bun test")
      --deny <rule>          deny a command prefix, repeatable ("git push")

${bold("OUTPUT")}
  -v, --verbose              print full tool output
      --show-thinking        stream the model's reasoning
      --theme <name>         opencode | dracula | zenburn | plain (default: opencode)
      --refresh              re-fetch the models.dev catalog (providers/models)
  -m, --method <how>         api | env, for providers login (skips the question)
                             with --provider and --model, -m env needs no terminal
  -h, --help                 show this help

${bold("EXAMPLES")}
  rocky -p "fix the failing test" --allow "bun test"
  rocky --provider ollama --model qwen3:8b
  rocky --provider openai --model gpt-5 -p "explain src/loop.ts"
  rocky --provider openai-compatible --base-url http://127.0.0.1:8080/v1 --model local
  MINIMAX_API_KEY=... rocky --provider minimax --model MiniMax-M2.7
  rocky providers login --provider minimax --model MiniMax-M2.7 -m env
  rocky models minimax --verbose

${bold("EXIT CODES")}
  0 ok   1 error   2 bad config   130 interrupted`;

function parse() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        print: { type: "string", short: "p" },
        model: { type: "string" },
        backend: { type: "string" },
        provider: { type: "string" },
        "base-url": { type: "string" },
        effort: { type: "string" },
        cwd: { type: "string" },
        "no-thinking": { type: "boolean" },
        "permission-mode": { type: "string" },
        yolo: { type: "boolean" },
        allow: { type: "string", multiple: true },
        deny: { type: "string", multiple: true },
        verbose: { type: "boolean", short: "v" },
        "show-thinking": { type: "boolean" },
        theme: { type: "string" },
        help: { type: "boolean", short: "h" },
        // Hidden: split-footer renderer smoke harness (see src/tui/app/smoke.tsx).
        "tui-smoke": { type: "boolean" },
        // `rocky providers login` / `rocky models`, mirroring opencode's flags.
        refresh: { type: "boolean" },
        method: { type: "string", short: "m" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    console.error(red((e as Error).message));
    console.error(`\nRun ${bold("rocky --help")} for usage.`);
    process.exit(EXIT_CONFIG);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parse();

  if (values.help) {
    console.log(HELP);
    return EXIT_OK;
  }

  if (values["tui-smoke"]) {
    const { ensureSolidJsx } = await import("./tui/app/jsx.ts");
    await ensureSolidJsx();
    const { runSmoke } = await import("./tui/app/smoke.tsx");
    return runSmoke();
  }

  const cwd = resolve(values.cwd ?? process.cwd());

  const overrides: Record<string, unknown> = {};
  if (values.model) overrides["model"] = values.model;
  if (values.backend) overrides["backend"] = values.backend;
  if (values.effort) overrides["effort"] = values.effort;
  if (values["no-thinking"]) overrides["thinking"] = false;
  if (values.yolo) overrides["permissionMode"] = "yolo";
  if (values["permission-mode"]) overrides["permissionMode"] = values["permission-mode"];
  if (values.theme) overrides["theme"] = values.theme;

  const providerOverride: Record<string, unknown> = {};
  if (values.provider) providerOverride["kind"] = values.provider;
  if (values["base-url"]) providerOverride["baseUrl"] = values["base-url"];
  if (Object.keys(providerOverride).length > 0) overrides["provider"] = providerOverride;

  let config;
  try {
    ({ config } = loadConfig(cwd, overrides));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(red(`Config error in ${e.message}`));
      return EXIT_CONFIG;
    }
    throw e;
  }

  // Apply the configured theme (if valid; falls back to opencode on error).
  try {
    setTheme(config.theme);
  } catch (e) {
    console.error(yellow(`Warning: ${e instanceof Error ? e.message : String(e)}`));
    console.error(yellow("Falling back to 'opencode' theme.\n"));
  }

  const subcommand = positionals[0];
  if (subcommand === "doctor") {
    let doctorBroker: BrokerServer | undefined;
    try {
      if (config.backend === "trueforge") {
        doctorBroker = await ensureBrokerServer(cwd, config).catch(() => undefined);
      }
      const checks = await doctor(cwd, config);
      console.log(formatDoctor(checks));
      return checks.some((check) => check.required && !check.ok) ? EXIT_ERROR : EXIT_OK;
    } finally {
      doctorBroker?.stop();
    }
  }
  if (subcommand === "providers" || subcommand === "auth" || subcommand === "models") {
    const { runProvidersSubcommand } = await import("./cli_providers.ts");
    return runProvidersSubcommand(positionals, config, {
      ...(values.refresh === true ? { refresh: true } : {}),
      ...(values.verbose === true ? { verbose: true } : {}),
      ...(values.provider ? { provider: values.provider } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values.method ? { method: values.method } : {}),
    });
  }
  if (subcommand === "broker") {
    const server = startBrokerServer(cwd, config);
    console.log(`${green("✓")} Rocky worker broker listening on ${server.url}`);
    console.log(dim(`bearer token stored under .rocky/broker; configure TrueForge MCP as ${config.trueforge.brokerMcpName}`));
    await new Promise<void>((resolveStop) => {
      const stop = () => {
        server.stop();
        resolveStop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return EXIT_OK;
  }
  let provider: Provider;
  if (config.backend === "trueforge") {
    provider = trueForgeAccountingProvider(config);
  } else {
    try {
      // The registry's stored key is a fallback here; env still wins.
      provider = providerFor(config.provider, config.activeProvider).provider;
    } catch (e) {
      if (e instanceof ProviderConfigError) {
        console.error(red(e.message));
        return EXIT_CONFIG;
      }
      throw e;
    }
  }

  // Discover the model's real limits before anything is accounted against them.
  // Never throws; a provider that cannot introspect keeps its defaults.
  if (config.backend === "local") await provider.prepare?.(config.model);

  const session = new Session({ cwd, config, provider, projectDir: cwd });
  if (config.backend === "trueforge" && config.trueforge.model) {
    session.model = config.trueforge.model;
  }
  const registry = makeRegistry();
  let brokerServer: BrokerServer | undefined;
  let backend: AgentBackend;
  if (config.backend === "trueforge") {
    brokerServer = await ensureBrokerServer(cwd, config);
    const trueforge = new TrueForgeBackend(cwd, config);
    trueforge.configureBroker(brokerServer.url, brokerServer.token);
    backend = trueforge;
  } else {
    backend = new LocalBackend(session, registry);
  }

  // Standing instructions the project keeps for its agents (ROCKY.md/AGENTS.md).
  let memory: string | undefined;
  try {
    memory = loadProjectMemory(cwd);
  } catch (e) {
    console.error(red((e as Error).message));
    return EXIT_CONFIG;
  }

  // `-p` was passed at all (even empty), or stdin is a pipe: no TTY to talk to.
  const piped = !process.stdin.isTTY;
  const nonInteractive = values.print !== undefined || piped;

  let prompt = values.print ?? positionals.join(" ").trim();
  if (piped && !prompt) prompt = (await Bun.stdin.text()).trim();

  const engine = new PermissionEngine({
    mode: config.permissionMode,
    allow: [...config.allow, ...(values.allow ?? [])],
    deny: [...config.deny, ...(values.deny ?? [])],
    projectDir: cwd,
    // Without a terminal there is nobody to ask, so `ask` mode denies rather
    // than hangs. The denial message says exactly how to unblock it.
    ask: nonInteractive ? nonInteractiveAsk() : ttyAsk(process.stdout),
    notify: (m) => process.stderr.write(`${yellow("!")} ${m}\n`),
  });

  if (nonInteractive) {
    if (!prompt) {
      console.error(red('No prompt. Usage: rocky -p "<prompt>"'));
      return EXIT_CONFIG;
    }
    try {
      return await runOnce(session, backend, engine, prompt, {
        verbose: values.verbose ?? false,
        showThinking: values["show-thinking"] ?? false,
        memory,
      });
    } finally {
      brokerServer?.stop();
    }
  }

  // The OpenTUI footer REPL is the default; ROCKY_LEGACY_TUI=1 is the escape
  // hatch back to the hand-rolled interface for one release.
  const replFn = process.env["ROCKY_LEGACY_TUI"] ? repl : replFooter;
  try {
    return await replFn(session, backend, engine, {
      verbose: values.verbose ?? false,
      showThinking: values["show-thinking"] ?? true,
      initialPrompt: prompt || undefined,
      memory,
    });
  } finally {
    brokerServer?.stop();
  }
}

/** Turn provider plumbing errors into something the user can act on. */
function explain(e: unknown): { message: string; code: number } {
  const raw = e instanceof Error ? e.message : String(e);

  if (raw.includes("Could not resolve authentication method")) {
    return {
      code: EXIT_CONFIG,
      message:
        "No API credentials found.\n" +
        "  Set ANTHROPIC_API_KEY, or run `ant auth login`,\n" +
        "  or point provider.apiKeyEnv at a different variable in .rocky/config.json",
    };
  }
  if (raw.includes("401") || raw.toLowerCase().includes("authentication")) {
    return { code: EXIT_CONFIG, message: `Authentication failed: ${raw}` };
  }
  if (raw.includes("ECONNREFUSED") || raw.includes("Unable to connect")) {
    return {
      code: EXIT_ERROR,
      message:
        `Cannot reach the model server: ${raw}\n` +
        "  If you meant to use Ollama, check it is running: `ollama serve`",
    };
  }
  return { code: EXIT_ERROR, message: raw };
}

type RenderOpts = { verbose: boolean; showThinking: boolean; memory?: string };

function recordBackendEvent(
  session: Session,
  backend: AgentBackend,
  event: LoopEvent,
): void {
  if (event.type !== "turn_end" || backend.kind !== "trueforge") return;
  session.recordUsage(event.usage);
  if (event.costUsd !== undefined) session.recordBackendCost(event.costUsd);
  session.turns++;
}

/** Restore persisted TrueForge scrollback without making a history outage fatal to the REPL. */
async function replayHistory(
  session: Session,
  backend: AgentBackend,
  renderer: Renderer,
): Promise<void> {
  if (!backend.replay) return;
  try {
    for await (const event of backend.replay()) {
      recordBackendEvent(session, backend, event);
      renderer.handle(event);
    }
  } catch (error) {
    renderer.handle({
      type: "notice",
      text: `could not restore persisted session history: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    renderer.close();
  }
}

/** Drive one turn and return whether it was interrupted. */
async function drive(
  session: Session,
  backend: AgentBackend,
  engine: PermissionEngine,
  prompt: string,
  renderer: Renderer,
  signal: AbortSignal,
  keys?: KeyWatcher,
  memory?: string,
): Promise<{ interrupted: boolean }> {
  let interrupted = false;
  const check = engine.check.bind(engine);
  // Recomputed each turn: /plan can flip the mode between prompts.
  const extraSystem = [
    ...(memory ? [memory] : []),
    ...(engine.mode === "plan" ? [PLAN_MODE_PROMPT] : []),
  ];
  const localApprove = keys
    ? async (...args: Parameters<typeof check>) => {
        keys.pause();
        renderer.quiet();
        try {
          return await check(...args);
        } finally {
          keys.resume();
        }
      }
    : check;
  const approveAction = async (request: BackendApprovalRequest) => {
    keys?.pause();
    renderer.quiet();
    try {
      const answer = await engine.askExternal({
        tool: { name: request.toolName },
        title: request.title,
        ...(request.preview ? { preview: request.preview } : {}),
        onceOnly: true,
      });
      return answer.kind === "no"
        ? { allow: false, ...(answer.reason ? { reason: answer.reason } : {}) }
        : { allow: true };
    } finally {
      keys?.resume();
    }
  };

  // The first stretch of a turn is pure model latency; show it.
  renderer.wait();
  try {
    for await (const event of backend.turn(prompt, {
      signal,
      localApprove,
      ...(extraSystem.length > 0 ? { extraSystem } : {}),
      approveAction,
    })) {
      if (event.type === "turn_end") {
        if (event.stopReason === "aborted") interrupted = true;
      }
      recordBackendEvent(session, backend, event);
      renderer.handle(event);
    }
  } finally {
    if (signal.aborted) await backend.cancel().catch(() => undefined);
  }
  return { interrupted };
}

async function runOnce(
  session: Session,
  backend: AgentBackend,
  engine: PermissionEngine,
  prompt: string,
  opts: RenderOpts,
): Promise<number> {
  // stdout is reserved for the answer, so the trace goes to stderr.
  const renderer = new Renderer(process.stderr, opts);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  try {
    const { interrupted } = await drive(
      session,
      backend,
      engine,
      prompt,
      renderer,
      controller.signal,
      undefined,
      opts.memory,
    );
    renderer.close();
    if (interrupted) return EXIT_INTERRUPTED;

    const answer = renderer.finalText;
    if (answer) {
      process.stdout.write(`${answer}\n`);
    } else {
      // Empty stdout with exit 0 is confusing, so say what happened — but do
      // not fail the run. The agent may have done the work and simply not
      // narrated it; exit codes report errors, not chattiness.
      process.stderr.write(yellow("! the model ended its turn without a text answer\n"));
    }
    process.stderr.write(`\n${summary(session)}\n`);
    return EXIT_OK;
  } catch (e) {
    renderer.close();
    const { message, code } = explain(e);
    console.error(red(`\n${message}`));
    return code;
  }
}

/**
 * Slash commands for the footer REPL. Returns "exit" to leave, "handled" when
 * the command ran (nothing goes to the model), "prompt" otherwise.
 * The legacy repl keeps its own inline chain until it is retired.
 */
async function runSlashCommand(
  trimmed: string,
  env: {
    session: Session;
    backend: AgentBackend;
    engine: PermissionEngine;
    log: ToolLog;
    planState: { modeBeforePlan: PermissionMode };
    workerState: { selected: string };
    provider: ProviderCommandCtx;
  },
): Promise<"exit" | "handled" | "prompt"> {
  const { session, backend, engine, log, planState, workerState } = env;

  // A registration in flight owns the next line, whatever it looks like — the
  // answer to "model?" is not a prompt for the agent, and a pasted key least of
  // all. This has to come before every other branch for that reason.
  if (awaitingProviderAnswer(env.provider)) {
    await runProviderWizardLine(trimmed, env.provider);
    return "handled";
  }

  if (trimmed === "/exit" || trimmed === "/quit") return "exit";
  if (trimmed === "/help") {
    console.log(
      advertisedCommands()
        .map((c) => `  ${cyan(c.usage.padEnd(14))}${dim(c.what)}`)
        .join("\n") +
        `\n  ${dim("Tab completes commands · type ahead during a turn to queue it")}`,
    );
    return "handled";
  }
  if (trimmed === "/plan") {
    if (engine.mode === "plan") {
      engine.setMode(planState.modeBeforePlan);
      console.log(
        gray(`plan mode off — back to ${engine.mode}. Tell Rocky to execute the plan.`),
      );
    } else {
      planState.modeBeforePlan = engine.mode;
      engine.setMode("plan");
      console.log(gray("plan mode on — read-only. /plan again to allow execution."));
    }
    return "handled";
  }
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const next = trimmed.slice("/model".length).trim();
    if (!next) {
      console.log(
        `${bold(session.model)} ${dim(
          `· ${session.provider.name} · ${compactNumber(session.contextWindow)} ctx`,
        )}`,
      );
      return "handled";
    }
    if (backend.kind === "trueforge") {
      console.log(yellow("the TrueForge model is fixed for this server session; update trueforge.model and start a new session"));
      return "handled";
    }
    // Re-probe: a different model can have a different window and may or
    // may not think. Accounting must follow the model, not the session.
    await session.provider.prepare?.(next);
    session.model = next;
    console.log(gray(`model → ${next} (${compactNumber(session.contextWindow)} ctx)`));
    return "handled";
  }
  if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
    await runProviderCommand(trimmed.slice("/provider".length), env.provider);
    return "handled";
  }
  if (trimmed === "/connect" || trimmed.startsWith("/connect ")) {
    const arg = trimmed.slice("/connect".length).trim();
    await runConnect(env.provider, arg === "refresh" || arg === "--refresh");
    return "handled";
  }
  if (trimmed === "/models" || trimmed.startsWith("/models ")) {
    await runModels(env.provider);
    return "handled";
  }
  if (trimmed === "/expand" || trimmed.startsWith("/expand ")) {
    const arg = trimmed.slice("/expand".length).trim();
    const id = arg ? Number(arg) : log.size;
    const entry = Number.isInteger(id) ? log.get(id) : undefined;
    if (!entry) {
      console.log(
        yellow(
          log.size === 0 ? "nothing to expand yet" : `no such result: ${arg || id}. Try 1–${log.size}.`,
        ),
      );
      return "handled";
    }
    console.log(`${bold(entry.name)} ${dim(`#${id}`)}\n${entry.output}`);
    return "handled";
  }
  if (trimmed === "/cost") {
    console.log(costReport(session));
    return "handled";
  }
  if (trimmed === "/compact") {
    const outcome = await compactSession(session, new AbortController().signal);
    console.log(
      outcome.ok
        ? gray(
            `compacted ${outcome.before} → ${outcome.after} messages ` +
              `(${outcome.droppedMessages} summarized)`,
          )
        : yellow(`nothing to compact: ${outcome.reason}`),
    );
    return "handled";
  }
  if (trimmed === "/permissions") {
    console.log(permissionsReport(engine));
    return "handled";
  }
  if (trimmed === "/info") {
    console.log(infoReport(session, engine));
    return "handled";
  }
  if (trimmed === "/clear") {
    session.messages = [];
    session.resetContextMeter();
    console.log(gray("history cleared"));
    return "handled";
  }
  if (trimmed === "/history") {
    // The footer UI prints into the terminal's own scrollback; scroll or
    // search with the terminal, which does it better than a pager can.
    console.log(gray("output lives in your terminal's scrollback now — scroll or search there"));
    return "handled";
  }
  if (trimmed === "/sessions") {
    if (!backend.sessions) console.log(gray("the local backend has no persisted server sessions"));
    else console.log(JSON.stringify(await backend.sessions(), null, 2));
    return "handled";
  }
  if (trimmed === "/workers") {
    const broker = new WorkerBroker(session.projectDir, session.config);
    try {
      console.log(JSON.stringify(broker.recommend(), null, 2));
    } finally {
      broker.close();
    }
    return "handled";
  }
  if (trimmed === "/worker" || trimmed.startsWith("/worker ")) {
    const selected = trimmed.slice("/worker".length).trim();
    if (!selected) console.log(`${bold("worker")} ${workerState.selected}`);
    else if (backend.kind !== "trueforge") {
      console.log(yellow("external worker selection is available on the TrueForge backend"));
    }
    else if (selected !== "auto" && !session.config.broker.workers[selected]) {
      console.log(yellow(`unknown worker: ${selected}`));
    } else {
      workerState.selected = selected || "auto";
      console.log(gray(`worker selection → ${workerState.selected}`));
    }
    return "handled";
  }
  if (trimmed === "/sandbox") {
    console.log(JSON.stringify(backend.status(), null, 2));
    return "handled";
  }
  if (trimmed === "/doctor") {
    console.log(formatDoctor(await doctor(session.projectDir, session.config)));
    return "handled";
  }
  if (trimmed === "/diff") {
    const diff = Bun.spawnSync(["git", "-C", session.projectDir, "diff", "--stat"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    console.log(diff.exitCode === 0 ? diff.stdout.toString().trim() || gray("no workspace diff") : yellow(diff.stderr.toString()));
    return "handled";
  }
  if (trimmed === "/undo") {
    const answer = await engine.askExternal({
      tool: { name: "workspace_undo" },
      title: `restore the latest checkpoint in ${session.projectDir}`,
      onceOnly: true,
    });
    if (answer.kind === "no") console.log(yellow(answer.reason ?? "undo denied"));
    else console.log(JSON.stringify(undoWorkspacePatch(session.projectDir, true), null, 2));
    return "handled";
  }
  // `/heal` intentionally reaches the root agent as an explicit diagnostic request.
  if (trimmed === "/heal") return "prompt";
  // Everything below goes to the model — but a lone "/word" that is not a
  // command is a typo, and the model can do nothing useful with it.
  const unknown = unknownCommand(trimmed);
  if (unknown) {
    console.log(`${yellow(`unknown command: ${unknown}`)} ${dim("· /help lists them")}`);
    return "handled";
  }
  return "prompt";
}

/** Provider-command output: headline plain, indented detail lines dimmed. */
function providerOut(line: string): void {
  console.log(
    line
      .split("\n")
      .map((l, i) => (i === 0 ? l : dim(l)))
      .join("\n"),
  );
}

/** The OpenTUI-footer REPL: scrollback above, live editor/status below. */
async function replFooter(
  session: Session,
  backend: AgentBackend,
  engine: PermissionEngine,
  opts: RenderOpts & { initialPrompt?: string },
): Promise<number> {
  const historyPath = join(homedir(), ".rocky", "history");
  let history: string[];
  try {
    history = parseHistory(readFileSync(historyPath, "utf8"));
  } catch {
    history = [];
  }

  console.log(
    `${banner({
      version: pkg.version,
      model: session.model,
      provider: backend.displayName,
      mode: engine.mode,
      cwd: session.cwd,
      ...(process.stdout.columns !== undefined ? { columns: process.stdout.columns } : {}),
    })}\n`,
  );

  const log = new ToolLog();
  // `backend` is reassigned by /provider use: activating a registered provider
  // under TrueForge moves this session onto the local loop. Every read below
  // goes through the binding, so the swap is picked up without a restart.
  const providerCtx: ProviderCommandCtx = {
    session,
    backendKind: () => backend.kind,
    switchToLocal: () => {
      backend = new LocalBackend(session, makeRegistry());
    },
    out: providerOut,
    wizard: { active: null as Wizard | null },
  };

  await replayHistory(session, backend, new Renderer(process.stdout, { ...opts, log }));
  const statusInfo = () => {
    const u = session.totalUsage;
    const state = backend.status();
    return {
      provider: backend.displayName,
      model: session.model,
      contextUsed: session.contextUsed,
      contextWindow: session.contextWindow,
      mode: engine.mode,
      tokensIn: u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens,
      tokensOut: u.outputTokens,
      costUsd: session.costUsd,
      backendConnection: state.connection,
      ...(state.sessionId ? { backendSession: state.sessionId.slice(0, 8) } : {}),
      workers: `${Object.values(session.config.broker.workers).filter((worker) => worker.enabled).length} enabled`,
      sandbox: state.sandbox,
      phase: state.phase,
    };
  };

  const { AsyncQueue } = await import("./tui/app/queue.ts");
  const { createFooterStore } = await import("./tui/app/store.ts");
  const submissions = new AsyncQueue<string>();
  let controller = new AbortController();
  const store = createFooterStore(statusInfo(), {
    onSubmit: (text) => {
      submissions.push(text);
      store.setQueued([...submissions.pending]);
    },
    onInterrupt: () => controller.abort(),
    onExit: () => submissions.close(),
  });
  store.setHistory(history);

  const { bootFooter } = await import("./tui/app/boot.ts");
  let footer;
  try {
    footer = await bootFooter(store);
  } catch (e) {
    console.error(
      yellow(`footer UI unavailable (${e instanceof Error ? e.message : String(e)})`),
    );
    console.error(yellow("falling back to the legacy interface"));
    return repl(session, backend, engine, opts, true);
  }
  engine.setAsk(footerAsk(store));
  // The pickers only exist under the footer TUI; the legacy REPL leaves `ui`
  // unset and /connect falls back to the typed wizard there.
  providerCtx.ui = {
    select: (opts) => store.askSelect(opts),
    prompt: (opts) => store.askPrompt(opts),
  };

  // Ctrl-C arrives as a key event while OpenTUI holds raw mode; this covers
  // `kill -INT` from outside the terminal.
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  const planState = { modeBeforePlan: (engine.mode === "plan" ? "ask" : engine.mode) as PermissionMode };
  const workerState = { selected: "auto" };

  try {
    if (opts.initialPrompt !== undefined) submissions.push(opts.initialPrompt);
    for (;;) {
      const input = await submissions.next();
      store.setQueued([...submissions.pending]);
      if (input === undefined) break;
      const trimmed = input.trim();
      // An empty line is meaningful mid-registration — it accepts an offered
      // default or skips the key step. Anywhere else it is a stray Enter.
      if (!trimmed && !awaitingProviderAnswer(providerCtx)) continue;

      const glyph =
        engine.mode === "plan" ? `${magenta("plan")} ${cyan("›")} ` : `${cyan("›")} `;
      // A pasted API key is echoed as bullets and kept out of history: the
      // scrollback outlives the session, and ~/.rocky/history is plaintext.
      console.log(`${glyph}${awaitingSecret(providerCtx) ? "••••••••" : trimmed}`);
      if (!trimmed.startsWith("/") && !awaitingProviderAnswer(providerCtx)) {
        history.unshift(trimmed);
        store.setHistory([...history]);
      }

      let outcome: Awaited<ReturnType<typeof runSlashCommand>>;
      try {
        outcome = await runSlashCommand(trimmed, {
          session,
          backend,
          engine,
          log,
          planState,
          workerState,
          provider: providerCtx,
        });
      } catch (e) {
        // A command that fails is a command that failed, not a session that
        // ends. /connect writes two files and can lose either one to a full
        // disk or a read-only home; that must come back as a line of output
        // with the loop still running, not as a rejection out of the REPL.
        console.error(red(explain(e).message));
        store.setStatus(statusInfo());
        continue;
      }
      if (outcome === "exit") break;
      if (outcome === "handled") {
        store.setStatus(statusInfo());
        continue;
      }

      controller = new AbortController();
      const renderer = new Renderer(process.stdout, {
        ...opts,
        log,
        providerName: backend.displayName,
        modelName: session.model,
        permissionMode: engine.mode,
        // The clock restarts per activity stretch ("Observing" → "running
        // bash" → "streaming"), matching what the old spinner counted: how
        // long the *current* thing has been happening.
        onActivity: (label) =>
          store.setBusy((prev) => {
            const next = label ?? "streaming";
            return prev && prev.label === next
              ? prev
              : { since: Date.now(), label: next };
          }),
      });
      store.setBusy({ since: Date.now(), label: "starting" });
      try {
        await drive(
          session,
          backend,
          engine,
          workerState.selected === "auto" ? trimmed : `@${workerState.selected}\n${trimmed}`,
          renderer,
          controller.signal,
          undefined,
          opts.memory,
        );
        renderer.close();
        console.log(summary(session));
      } catch (e) {
        renderer.close();
        console.error(red(explain(e).message));
      } finally {
        store.setBusy(null);
        store.setStatus(statusInfo());
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    footer.destroy();
    try {
      writeFileSync(historyPath, serializeHistory(history.slice(0, HISTORY_LIMIT)));
    } catch {
      // best effort
    }
  }
  // How Rocky says goodbye. (Eridians shake on a job well done.)
  console.log(gray("♫ fist my bump"));
  return EXIT_OK;
}

async function repl(
  session: Session,
  backend: AgentBackend,
  engine: PermissionEngine,
  opts: RenderOpts & { initialPrompt?: string },
  historyRestored = false,
): Promise<number> {
  const historyPath = join(homedir(), ".rocky", "history");
  let history: string[];
  try {
    history = parseHistory(readFileSync(historyPath, "utf8"));
  } catch {
    history = [];
  }

  console.log(
    `${banner({
      version: pkg.version,
      model: session.model,
      provider: backend.displayName,
      mode: engine.mode,
      cwd: session.cwd,
      ...(process.stdout.columns !== undefined ? { columns: process.stdout.columns } : {}),
    })}\n`,
  );

  const log = new ToolLog();
  // See replFooter: /provider use can move this session onto the local loop,
  // so `backend` is a mutable binding rather than a captured constant.
  const providerCtx: ProviderCommandCtx = {
    session,
    backendKind: () => backend.kind,
    switchToLocal: () => {
      backend = new LocalBackend(session, makeRegistry());
    },
    out: providerOut,
    wizard: { active: null as Wizard | null },
  };

  const scrollback = new Scrollback();
  if (!historyRestored) {
    await replayHistory(
      session,
      backend,
      new Renderer(process.stdout, { ...opts, log, scrollback }),
    );
  }
  const statusBar = new StatusBar(process.stdout);
  statusBar.enable();
  const updateStatusBar = (busy: 0 | 1 | 2 = 0, wait?: string) => {
    const u = session.totalUsage;
    const state = backend.status();
    statusBar.update({
      provider: backend.displayName,
      model: session.model,
      contextUsed: session.contextUsed,
      contextWindow: session.contextWindow,
      mode: engine.mode,
      tokensIn: u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens,
      tokensOut: u.outputTokens,
      costUsd: session.costUsd,
      backendConnection: state.connection,
      backendSession: state.sessionId?.slice(0, 8),
      workers: `${Object.values(session.config.broker.workers).filter((worker) => worker.enabled).length} enabled`,
      sandbox: state.sandbox,
      phase: state.phase,
      busy,
      wait,
    });
  };
  updateStatusBar();
  /** Prompts waiting their turn: the initial one, then anything typed ahead. */
  const queue: string[] = opts.initialPrompt !== undefined ? [opts.initialPrompt] : [];
  /** An unfinished thought typed mid-turn; lands back in the editor. */
  let prefill = "";
  let lastSigint = 0;
  let controller = new AbortController();
  /** What /plan returns to. Sessions started in plan mode fall back to ask. */
  let modeBeforePlan: PermissionMode = engine.mode === "plan" ? "ask" : engine.mode;
  const workerState = { selected: "auto" };

  const interrupt = () => {
    controller.abort();
    process.stdout.write(yellow("\n(interrupted)\n"));
  };

  const onSigint = () => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      process.stdout.write("\n");
      process.exit(EXIT_INTERRUPTED);
    }
    lastSigint = now;
    controller.abort();
    process.stdout.write(yellow("\n(interrupted — Ctrl-C again to exit)\n"));
  };
  process.on("SIGINT", onSigint);

  let stdinClosed = false;

  try {
    for (;;) {
      if (stdinClosed && queue.length === 0) break;
      const glyph =
        engine.mode === "plan" ? `${magenta("plan")} ${cyan("›")} ` : `${cyan("›")} `;
      const queued = queue.shift();
      let input: string | undefined;
      if (queued !== undefined) {
        console.log(`${glyph}${queued}`);
        input = queued;
      } else {
        const editor = new Editor({
          prompt: glyph,
          prefill,
          history,
        });
        const result = await editor.read();
        if (result === undefined) {
          stdinClosed = true;
        } else {
          console.log(`${glyph}${awaitingSecret(providerCtx) ? "••••••••" : result.text}`);
          input = result.text;
          if (
            result.text.trim() &&
            !result.text.startsWith("/") &&
            !awaitingProviderAnswer(providerCtx)
          ) {
            history.unshift(result.text);
          }
        }
      }
      if (input === undefined) break;
      prefill = "";
      const trimmed = input.trim();

      // A registration in flight owns the next line — this REPL answers most
      // commands inline, so the check sits ahead of that table, and ahead of
      // the empty-line guard: Enter accepts a default or skips the key step.
      if (awaitingProviderAnswer(providerCtx)) {
        await runProviderWizardLine(trimmed, providerCtx);
        continue;
      }
      if (!trimmed) continue;

      if (trimmed === "/exit" || trimmed === "/quit") break;
      if (trimmed === "/help") {
        console.log(
          advertisedCommands()
            .map((c) => `  ${cyan(c.usage.padEnd(14))}${dim(c.what)}`)
            .join("\n") +
            `\n  ${dim("Tab completes commands · type ahead during a turn to queue it")}`,
        );
        continue;
      }
      if (trimmed === "/plan") {
        if (engine.mode === "plan") {
          engine.setMode(modeBeforePlan);
          console.log(
            gray(`plan mode off — back to ${engine.mode}. Tell Rocky to execute the plan.`),
          );
        } else {
          modeBeforePlan = engine.mode;
          engine.setMode("plan");
          console.log(gray("plan mode on — read-only. /plan again to allow execution."));
        }
        continue;
      }
      if (trimmed === "/model" || trimmed.startsWith("/model ")) {
        const next = trimmed.slice("/model".length).trim();
        if (!next) {
          console.log(
            `${bold(session.model)} ${dim(
              `· ${session.provider.name} · ${compactNumber(session.contextWindow)} ctx`,
            )}`,
          );
          continue;
        }
        if (backend.kind === "trueforge") {
          console.log(yellow("the TrueForge model is fixed for this server session; update trueforge.model and start a new session"));
          continue;
        }
        // Re-probe: a different model can have a different window and may or
        // may not think. Accounting must follow the model, not the session.
        await session.provider.prepare?.(next);
        session.model = next;
        console.log(
          gray(`model → ${next} (${compactNumber(session.contextWindow)} ctx)`),
        );
        continue;
      }
      if (trimmed === "/expand" || trimmed.startsWith("/expand ")) {
        const arg = trimmed.slice("/expand".length).trim();
        const id = arg ? Number(arg) : log.size;
        const entry = Number.isInteger(id) ? log.get(id) : undefined;
        if (!entry) {
          console.log(
            yellow(
              log.size === 0
                ? "nothing to expand yet"
                : `no such result: ${arg || id}. Try 1–${log.size}.`,
            ),
          );
          continue;
        }
        console.log(`${bold(entry.name)} ${dim(`#${id}`)}\n${entry.output}`);
        continue;
      }
      if (trimmed === "/cost") {
        console.log(costReport(session));
        continue;
      }
      if (trimmed === "/compact") {
        controller = new AbortController();
        const outcome = await compactSession(session, controller.signal);
        console.log(
          outcome.ok
            ? gray(
                `compacted ${outcome.before} → ${outcome.after} messages ` +
                  `(${outcome.droppedMessages} summarized)`,
              )
            : yellow(`nothing to compact: ${outcome.reason}`),
        );
        continue;
      }
      if (trimmed === "/permissions") {
        console.log(permissionsReport(engine));
        continue;
      }
      if (trimmed === "/info") {
        console.log(infoReport(session, engine));
        continue;
      }
      if (trimmed === "/clear") {
        session.messages = [];
        session.resetContextMeter();
        console.log(gray("history cleared"));
        continue;
      }
      if (trimmed === "/history") {
        if (scrollback.size === 0) {
          console.log(gray("no output to scroll through yet"));
          continue;
        }
        await scrollback.view(process.stdout, process.stdin);
        continue;
      }
      if (
        trimmed === "/sessions" ||
        trimmed === "/workers" ||
        trimmed === "/worker" ||
        trimmed.startsWith("/worker ") ||
        trimmed === "/sandbox" ||
        trimmed === "/heal" ||
        trimmed === "/diff" ||
        trimmed === "/undo" ||
        trimmed === "/doctor" ||
        trimmed === "/provider" ||
        trimmed.startsWith("/provider ") ||
        trimmed === "/connect" ||
        trimmed.startsWith("/connect ") ||
        trimmed === "/models" ||
        trimmed.startsWith("/models ")
      ) {
        const planState: { modeBeforePlan: PermissionMode } = { modeBeforePlan };
        let outcome: Awaited<ReturnType<typeof runSlashCommand>>;
        try {
          outcome = await runSlashCommand(trimmed, {
            session,
            backend,
            engine,
            log,
            planState,
            provider: providerCtx,
            workerState,
          });
        } catch (e) {
          // Same boundary as the footer REPL: see the comment there.
          console.error(red(explain(e).message));
          continue;
        }
        modeBeforePlan = planState.modeBeforePlan;
        if (outcome === "exit") break;
        if (outcome === "handled") continue;
      }
      // Everything below goes to the model — but a lone "/word" that is not a
      // command is a typo, and the model can do nothing useful with it.
      const unknown = unknownCommand(trimmed);
      if (unknown) {
        console.log(`${yellow(`unknown command: ${unknown}`)} ${dim("· /help lists them")}`);
        continue;
      }

      controller = new AbortController();
      const renderer = new Renderer(process.stdout, {
        ...opts,
        log,
        statusBar,
        scrollback,
        providerName: backend.displayName,
        modelName: session.model,
        permissionMode: engine.mode,
      });
      // The editor has already released stdin; the key watcher will take it.
      const keys = watchKeys({
        onEscape: interrupt,
        // Raw mode swallows SIGINT, so Ctrl-C only works because we forward it.
        onCtrlC: onSigint,
      });
      try {
        await drive(
          session,
          backend,
          engine,
          workerState.selected === "auto" ? trimmed : `@${workerState.selected}\n${trimmed}`,
          renderer,
          controller.signal,
          keys,
          opts.memory,
        );
        renderer.close();
        console.log(summary(session));
        updateStatusBar();
      } catch (e) {
        renderer.close();
        console.error(red(explain(e).message));
        updateStatusBar();
      } finally {
        // Whatever the user typed during the turn was theirs, not noise.
        // Finished lines run next; the unfinished tail reappears in the editor.
        const typed = splitTypeAhead(keys.drain());
        queue.push(...typed.lines);
        prefill = typed.partial;
        keys.dispose();
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    statusBar.disable();
    try {
      writeFileSync(historyPath, serializeHistory(history.slice(0, HISTORY_LIMIT)));
    } catch {
      // best effort
    }
  }
  // How Rocky says goodbye. (Eridians shake on a job well done.)
  console.log(gray("♫ fist my bump"));
  return EXIT_OK;
}

function permissionsReport(engine: PermissionEngine): string {
  const { mode, allow, deny } = engine.describe();
  const list = (xs: string[]) =>
    xs.length ? xs.map((x) => `    ${x}`).join("\n") : `    ${dim("(none)")}`;
  return [
    `${bold("mode")}  ${mode}`,
    `${bold("allow")}`,
    list(allow),
    `${bold("deny")}`,
    list(deny),
  ].join("\n");
}

/**
 * The one-line status printed after every turn. Styles itself, part by part —
 * wrapping the whole line in one colour cannot work, because the meter's own
 * reset would cancel it for everything after (that bug shipped once).
 */
function summary(session: Session): string {
  const u = session.totalUsage;
  const pct = Math.round(session.contextUsed * 100);
  const ctx =
    session.lastPromptTokens > 0
      ? `${meter(session.contextUsed)} ${dim(`${pct}% of ${compactNumber(session.contextWindow)}`)}`
      : `${meter(0)} ${dim("—")}`;

  const parts = [
    ctx,
    dim(`${compactNumber(u.inputTokens)} in`),
    dim(`${compactNumber(u.outputTokens)} out`),
    dim(`${compactNumber(u.cacheReadInputTokens)} cached`),
    dim(`$${session.costUsd.toFixed(4)}`),
  ];
  return parts.join(dim(" · "));
}

/** `/cost` — the full breakdown, including what caching actually saved. */
function costReport(session: Session): string {
  const u = session.totalUsage;
  if (session.provider.name === "TrueForge") {
    return [
      `${bold("model")}   ${session.model} ${dim("(TrueForge)")}`,
      `${bold("turns")}   ${session.turns}`,
      "",
      `  ${"input".padEnd(21)} ${compactNumber(u.inputTokens).padStart(8)}`,
      `  ${"cache write".padEnd(21)} ${compactNumber(u.cacheCreationInputTokens).padStart(8)}`,
      `  ${"cache read".padEnd(21)} ${compactNumber(u.cacheReadInputTokens).padStart(8)}`,
      `  ${"output".padEnd(21)} ${compactNumber(u.outputTokens).padStart(8)}`,
      "",
      `  ${"TrueForge total".padEnd(21)} ${"".padStart(8)}  ${`$${session.costUsd.toFixed(4)}`.padStart(10)}`,
      dim("  authoritative cost reported by completed TrueForge turns"),
    ].join("\n");
  }
  const { input, output } = session.provider.pricing(session.model);

  const rows: [string, string, string][] = [
    ["input (uncached)", compactNumber(u.inputTokens), `$${(u.inputTokens * input).toFixed(4)}`],
    [
      "input (cache write)",
      compactNumber(u.cacheCreationInputTokens),
      `$${(u.cacheCreationInputTokens * input * 1.25).toFixed(4)}`,
    ],
    [
      "input (cache read)",
      compactNumber(u.cacheReadInputTokens),
      `$${(u.cacheReadInputTokens * input * 0.1).toFixed(4)}`,
    ],
    ["output", compactNumber(u.outputTokens), `$${(u.outputTokens * output).toFixed(4)}`],
  ];

  // What the cache reads would have cost at full price, minus what they did.
  const saved = u.cacheReadInputTokens * input * 0.9;

  const lines = rows.map(
    ([label, tokens, cost]) => `  ${label.padEnd(21)} ${tokens.padStart(8)}  ${cost.padStart(10)}`,
  );

  return [
    `${bold("model")}   ${session.model} ${dim(`(${session.provider.name})`)}`,
    `${bold("turns")}   ${session.turns}${session.compactions ? dim(` · ${session.compactions} compaction(s)`) : ""}`,
    "",
    ...lines,
    `  ${"total".padEnd(21)} ${"".padStart(8)}  ${`$${session.costUsd.toFixed(4)}`.padStart(10)}`,
    "",
    saved > 0.00005
      ? green(`  prompt caching saved ~$${saved.toFixed(4)}`)
      : dim("  no cache reads yet"),
  ].join("\n");
}

/**
 * Session info panel — a compact dashboard of everything the session is doing.
 */
function infoReport(session: Session, engine: PermissionEngine): string {
  const u = session.totalUsage;
  const cols = process.stdout.columns ?? 80;

  const label = (s: string) => ` ${dim(s)}`;
  const value = (s: string) => ` ${bold(s)}`;

  const rows: string[] = [];

  // Provider row
  rows.push(`${cyan("▸")} ${bold("Rocky")} ${dim(`v${pkg.version}`)}`);
  rows.push("");

  // Model info
  rows.push(label("Model") + value(session.model));
  rows.push(label("Provider") + value(session.provider.name));
  rows.push(label("Mode") + value(engine.mode));
  rows.push("");

  // Context
  const pct = Math.round(session.contextUsed * 100);
  const ctx = session.lastPromptTokens > 0
    ? `${meter(session.contextUsed)} ${dim(`${pct}% of ${compactNumber(session.contextWindow)}`)}`
    : `${meter(0)} ${dim("—")}`;
  rows.push(label("Context") + ` ${ctx}`);
  rows.push("");

  // Tokens
  rows.push(label("Tokens"));
  rows.push(`  ${dim("input:")}   ${compactNumber(u.inputTokens)} ${dim(`(+${compactNumber(u.cacheCreationInputTokens)} cache write, ${compactNumber(u.cacheReadInputTokens)} read)`)}`);
  rows.push(`  ${dim("output:")}  ${compactNumber(u.outputTokens)}`);
  rows.push("");

  // Session
  rows.push(label("Session"));
  rows.push(`  ${dim("turns:")}       ${session.turns}`);
  if (session.compactions > 0) {
    rows.push(`  ${dim("compactions:")}  ${session.compactions}`);
  }
  rows.push(`  ${dim("messages:")}    ${session.messages.length}`);
  rows.push("");

  // Cost
  const { input, output } = session.provider.pricing(session.model);
  const totalCost = session.costUsd;
  rows.push(label("Cost"));
  rows.push(`  ${dim("total:")} $${totalCost.toFixed(4)}`);
  if (input > 0 || output > 0) {
    rows.push(`  ${dim("rate:")}  ${dim(`$${input}/1K in · $${output}/1K out`)}`);
  }

  // Box it
  const inner = Math.max(...rows.map(stripAnsi).map((s) => s.length));
  const width = Math.min(inner + 4, cols - 2);
  const pad = (s: string) => {
    const visible = stripAnsi(s);
    return s + " ".repeat(width - 2 - visible.length);
  };

  const box = [
    dim(`┌${"─".repeat(width - 2)}┐`),
    ...rows.map((r) => dim("│") + ` ${pad(r)}` + dim("│")),
    dim(`└${"─".repeat(width - 2)}┘`),
  ];

  return box.join("\n");
}

process.exit(await main());
