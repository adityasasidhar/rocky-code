# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Rocky is a terminal coding agent whose specialty is **orchestration**: a TrueForge root
agent plans and validates, while disposable Codex / Claude Code / OpenCode workers running
in pinned Docker containers produce candidate patches. Nothing a worker writes touches the
user's checkout until it clears Daytona validation, a TrueForge approval, and a checkpointed
apply. The whole design follows from that boundary — read `DESIGN.md` before any structural
change; it records why each decision was made and which bugs motivated it.

## Commands

```bash
bun install                                    # deps (Bun only — never npm/npx)

bun run src/cli.ts                             # interactive, TrueForge backend (default)
bun run src/cli.ts -p "fix the failing test"   # one-shot; piped stdin also forces this mode
bun run src/cli.ts --backend local --provider ollama --model qwen3:8b   # original local loop
bun run src/cli.ts doctor                      # preflight: TrueForge/Daytona/broker/Docker/workers (never prints secrets)
bun run src/cli.ts broker                      # standalone MCP worker broker (reused if already up)
bun run src/cli.ts --tui-smoke                 # hidden TUI harness

bunx tsc --noEmit                              # typecheck; `bun run lint` is the same command
bun test                                       # full suite
bun test test/tools/bash.test.ts               # one file (path must contain .test./_test_/.spec.)
bun test test/tools/bash.test.ts -t "denies redirection"   # one test by name regex (-t/--test-name-pattern; --filter is a Jest-ism, silently no-ops)
bun test --changed                             # only tests touching files changed vs HEAD
ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts   # needs the locally-built rocky-worker-fixture:1 image
bun bench/run.ts                               # bench harness (not run by `bun test`)
```

There is **no build step** — `package.json:module`/`bin` point straight at `src/cli.ts`.
Worker images build from `docker/workers/Dockerfile.*` with explicit `--build-arg` versions
(see README); `:latest` is rejected at config-validation time.

## Architecture

**Request path**: `src/cli.ts` → `Session` (`src/core/session.ts`) → `AgentBackend`
(`src/backend/`) → `Provider` (`src/core/provider/`).

- **Two backends behind one interface** (`src/backend/types.ts`: `turn()`, `cancel()`,
  `status()`, `sessions()`). `trueforge` (default) owns SSE streaming, reconnect cursors,
  Daytona, and the MCP broker; `local` calls `runTurn()` straight at a provider. Both emit
  the same `LoopEvent` stream, so the renderer never learns which one is active.
- **`src/core/loop.ts` is pure**: no I/O, no globals, and it never throws for tool failures.
  Every `tool_use` yields exactly one `tool_result`; handler throws are caught here and
  converted to `is_error: true`. Errors are data, not exceptions.
- **Broker** (`src/broker/`): a localhost-only MCP server on `127.0.0.1:8791`, bearer token
  in `.rocky/broker`. `adapters.ts` normalizes each worker CLI's stream shape (Codex JSONL,
  Claude streaming-JSON print mode, OpenCode JSON run mode); malformed streams fall back to
  plain text and count as an adapter-health regression. `recovery.ts` caps automated retries
  at 3 and classifies failures — auth/config errors stop with guidance, timeouts get one
  reduced retry then a worker switch.
- **Providers** (`src/core/provider/`): five config kinds (`anthropic`, `openai`,
  `openai-compatible`, `minimax`, `ollama`) but only three classes — `openai.ts`'s
  `OpenAICompatibleProvider` backs three of them, differing only in
  `useMaxCompletionTokens` / `sendReasoningEffort` / `name`. `provider/index.ts` is the only
  file that knows which kinds exist; add a kind there.
- **Message types live in `src/core/types.ts`**, deliberately not imported from
  `@anthropic-ai/sdk`. Providers adapt at their own boundary.
- **Tools** (`src/tools/`): pure `(input, ctx) => ToolResult`. Read-only tools run in
  parallel, mutating ones serialize. The registry uses `erase()` type erasure rather than
  `any`, and Zod validates model-supplied input at the boundary.
- **TUI** (`src/tui/`): scrollback is plain terminal output; `src/tui/app/` is a Solid +
  OpenTUI footer (`screenMode: "split-footer"`, `capture-stdout`) owning editor, status,
  spinner, and dialogs. `ROCKY_LEGACY_TUI=1` falls back to the hand-rolled
  `editor.ts`/`keys.ts`/`status.ts`.
- **Workspace** (`src/workspace/`): `snapshot.ts` produces the sanitized, size-limited view
  sent upstream; `patch.ts` is the candidate-patch → checkpoint → apply → `undoWorkspacePatch`
  pipeline.

## Toolchain constraints

- **TypeScript strict plus `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`**
  — an unused parameter fails the typecheck, so prefix-with-underscore or drop it.
- **`bunfig.toml` preloads `@opentui/solid/preload`** for both runtime and tests. Bun's
  default JSX transform is React-style and silently breaks Solid reactivity — don't remove it.
- **`[test] root = "test"`** in `bunfig.toml` keeps the vendored `opencode/` reference
  checkout's suite from running as ours; `tsconfig.json` excludes `bench/tasks` because those
  fixtures have deliberate flaws and post-overlay import paths.
- **`@opentui/core@0.4.5` is patched** (`patches/@opentui%2Fcore@0.4.5.patch`) to parse SGR
  into styled spans for `capture-stdout` scrollback.
- `bun test` caches modules; stale failures clear with `rm -rf node_modules/.cache`.

## Config and state

Precedence low→high (`src/config/load.ts`): defaults → `~/.config/rocky/config.json` →
`.rocky/config.json` → the active named provider → CLI flags, with
`provider`/`trueforge`/`broker` merged one level deep. Schema and defaults are in
`src/config/schema.ts`; `docs/config.example.json` is the template.

- `.rocky/` — per-project session artifacts, broker token, archived tool outputs. Gitignored
  via an auto-generated `.rocky/.gitignore` containing `*`.
- `~/.rocky/settings.json` — persisted allow/deny grants. `~/.rocky/history` — capped at 1000.
- Project memory: `ROCKY.md` wins over `AGENTS.md` — an existing `ROCKY.md` (even empty)
  suppresses the `AGENTS.md` fallback entirely, it does not fall through. Only one file is
  loaded into `extraSystem`, capped at 24KB (UTF-8 byte-bounded), and an unreadable file
  throws rather than being silently skipped (`src/core/memory.ts`).
- **Provider registry**: `providers` (name → config + `model` + `catalogId`) and
  `activeProvider`. Activating *replaces* the `provider` block rather than merging into it,
  so a half-configured entry cannot inherit the previous one's `baseUrl`. Registry keys are
  models.dev provider ids. `src/config/write.ts` is the only config writer and it refuses to
  serialize a literal secret.
- **`/connect` and `/models`** (`src/core/connect_command.ts`) are the opencode-shaped
  pickers; `/provider` and `/model` survive as unadvertised aliases (`KNOWN` in
  `src/tui/input.ts`, not `SLASH_COMMANDS`). `src/config/catalog.ts` fetches models.dev,
  caches to `~/.cache/rocky/models.json`, and maps the `npm` field to a Rocky provider kind —
  181 of 207 providers map; the rest stay listed but refuse with the SDK name. Costs are
  quoted per *million* tokens upstream and divided by 1e6 on the way in.
- **Dialogs are the only masked input path.** `src/tui/app/store.ts` carries a three-way
  `DialogRequest` union (permission / select / prompt); `pickers.tsx` holds a masked value in
  a plain local so it never reaches a signal. Non-TTY and `ROCKY_LEGACY_TUI=1` have no
  dialogs, so both commands fall back to the typed wizard in `src/config/providers.ts` —
  don't delete it.
- **Stored keys** live in `~/.rocky/credentials.json` (0600), written only by `/connect` and
  `rocky providers login`, and are a *fallback* — an env var named by `apiKeyEnv` always wins.
  Keys never enter `~/.rocky/history` and are masked while being typed.
- Other secrets come only from env vars *named* by config (`provider.apiKeyEnv`,
  `trueforge.tokenEnv`, `broker.tokenEnv`, worker `credentialEnv`) — values are never inlined
  into config and never logged. The same `OPENAI_API_KEY` backs both `openai` and
  `openai-compatible`; `ollama` is auth-less.

## Behaviors that surprise people

- **Permissions** (`src/permissions/`): `deny` beats `yolo`; wrapper executables (`sudo`,
  `env`, `timeout`, …) are peeled by suffix match; `>`/`>>`/`&>`, `$(...)`, backticks, `eval`,
  and `exec` always prompt. Non-TTY `ask` denies with an unblock hint rather than hanging.
- **Cache breakpoints** (`src/core/provider/anthropic.ts`): at most 3, spaced ~12 blocks
  apart. `builtinTools` order is frozen — reordering or per-request filtering busts the cache.
- **Compaction** can fire even in `-p` mode, at most once per `runTurn`. The recap re-enters
  as a tagged `<conversation_summary>` *user* turn, not a system message.
- **Post-edit check** (`src/core/check.ts`): `config.check.command` runs once per batch
  containing a successful `edit_file`/`write_file` under `projectDir`; failure appends
  `<post_edit_check>` to the same user message, and a broken check (exit 126/127) disables
  itself after one notice.
- **Ollama startup probe**: `Provider.prepare()` hits `/api/show` for `contextWindow` and
  thinking capability, falling back to `DEFAULT_CONTEXT_WINDOW` (126k). A configured
  `contextWindow` always wins.
- **`SLASH_COMMANDS` in `src/tui/input.ts`** is the single source for `/help`, Tab
  completion, and the `unknownCommand` guard. Tab completes command names only, never args.
- **`Session` is mutable** — a known, documented tradeoff (`DESIGN.md`, "What I'd do differently").

## Testing

`test/` mirrors `src/`. Shared helpers are in `test/helpers.ts` (`tempDir()`, `cleanup()`,
`makeCtx()`); `test/mock_provider.ts` is the scripted provider. `test/integration/` needs a
live provider. Bench tasks in `bench/tasks/` carry `hidden/` overlays judged after the run —
the agent under test must not read them.

## Further reading

`AGENTS.md` (the project's own agent memory file) carries the full convention list;
`docs/SECURITY.md` the threat model, `docs/GENERATED_TOOLS.md` the session-only generated-tool
contract, `docs/DEMO.md` the recording outline.
