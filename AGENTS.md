# Rocky — Agent Instructions

## Commands

- **Install**: `bun install` (Bun 1.4+ only; never `npm`/`npx`)
- **Run (TrueForge default)**: `bun run src/cli.ts`
- **Run local loop**: `bun run src/cli.ts --backend local --provider ollama --model qwen3:8b`
- **One-shot**: `bun run src/cli.ts -p "fix the failing test"` (piped stdin also triggers non-interactive mode)
- **Verify setup**: `bun run src/cli.ts doctor` (TrueForge/Daytona/broker/Docker/workers; never prints secrets)
- **Broker standalone**: `bun run src/cli.ts broker` (bearer-auth on 127.0.0.1:8791; reused if already running)
- **Typecheck**: `bunx tsc --noEmit` (`lint` alias is identical; no separate linter)
- **Test all**: `bun test`
- **One file**: `bun test test/path/to/file.test.ts` (path must contain `.test.`/`.spec.`; pass `./foo.test.ts` if Bun treats it as filter)
- **One test**: `bun test test/path/file.test.ts -t "regex"` (`-t`/`--test-name-pattern`; `--filter` is Jest and silently no-ops)
- **Only changed tests**: `bun test --changed` (diff vs HEAD)
- **Container fixture**: `ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts` (requires locally-built `rocky-worker-fixture:1` — see README "Worker images")
- **Bench**: `bun bench/run.ts` (not via `bun test`; `bench/tasks/` excluded from typecheck — hidden overlays only resolve post-run)
- **CI order**: `bunx tsc --noEmit` then `bun test` (see `.github/workflows/ci.yml`)

No build step — `package.json:module/bin` point directly at `src/cli.ts`.

## Runtime & Toolchain

- **Bun, not Node.** Use `bun run`, `bun test`, `bunx`.
- **TypeScript strict** + `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` — unused vars/params fail typecheck.
- **Solid JSX**: `bunfig.toml` preloads `@opentui/solid/preload` for runtime and `[test]` — Bun's default React transform breaks Solid reactivity; don't remove.
- **Test isolation**: `bunfig.toml` `[test] root = "test"` prevents vendored `opencode/` tests from running. `tsconfig.json` excludes `bench/tasks` (fixtures have deliberate flaws and post-overlay imports).
- **Patched dep**: `@opentui/core@0.4.5` patched via `patches/@opentui%2Fcore@0.4.5.patch` to parse SGR into styled spans for `capture-stdout` scrollback.

## Architecture

- **Entry**: `src/cli.ts` → `Session` (`src/core/session.ts`) → `Backend` (`src/backend/`) → `Provider` (`src/core/provider/`)
  - `backend: "trueforge"` (default): streaming, SSE reconnect, Daytona, MCP broker. `backend: "local"` calls `runTurn()` directly.
- **Loop** (`src/core/loop.ts`): pure, yields `LoopEvent`s; no I/O/globals; never throws for tool failures (handler throws become `is_error: true` tool_results).
- **Backends** (`src/backend/trueforge.ts`, `src/backend/local.ts`) behind `AgentBackend` (`turn()`, `cancel()`, `status()`, `sessions()`).
- **Broker** (`src/broker/`): localhost MCP server on `127.0.0.1:8791`, bearer token in `.rocky/broker`, adapters per worker kind in `adapters.ts`, recovery policy in `recovery.ts` (max 3 attempts, classified).
- **Tools** (`src/tools/`): pure `(input, ctx) => ToolResult`; read-only run parallel, mutating serialize; always yield one `tool_result` per `tool_use`. Registry uses `erase()` + Zod at boundary, not `any`.
- **Providers** (`src/core/provider/`): 5 kinds (`anthropic`, `openai`, `openai-compatible`, `minimax`, `ollama`) behind `stream()`/`contextWindow()`/`pricing()`/`prepare()` — only 3 classes (`openai.ts` backs three kinds).
- **TUI** (`src/tui/`): streaming markdown + lexer highlighting. `src/tui/app/` is Solid/OpenTUI footer app (`screenMode: "split-footer"`, `capture-stdout`, `boot.ts` rebinds `console.log`). Scrollback is plain terminal; footer owns editor/status/spinner/dialog. `ROCKY_LEGACY_TUI=1` falls back to hand-rolled `editor.ts`/`keys.ts`/`status.ts`. Harness: `bun run src/cli.ts --tui-smoke`.
- **Workspace** (`src/workspace/`): `snapshot.ts` (sanitized, size-limited) + `patch.ts` (candidate patch → checkpoint → apply, `undoWorkspacePatch`).

## Config & Environment

- **Precedence** low→high (`src/config/load.ts`): defaults → `~/.config/rocky/config.json` → `.rocky/config.json` → active named provider → CLI flags. `provider`/`trueforge`/`broker` merge one level deep; `activeProvider` *replaces* `provider` wholesale.
- **Provider registry**: `providers` (name → config + `model` + `catalogId`) + `activeProvider` in `~/.config/rocky/config.json`. Only writer is `src/config/write.ts` — refuses literal secrets. Keys are models.dev provider ids.
- **models.dev catalog** (`src/config/catalog.ts`): fetched from `https://models.dev/api.json`, cached at `~/.cache/rocky/models.json` (24h TTL, `--refresh` forces). Network → cache → built-in seed; never hard-fails. `npm` field maps to Rocky kind; 181/207 providers map, rest listed but refuse with SDK name. **Upstream costs per million tokens — divide by 1e6.**
- **`/connect` + `/models`** (`src/core/connect_command.ts`) are picker-driven; typed wizard in `src/config/providers.ts` is non-TTY/`ROCKY_LEGACY_TUI=1` fallback — keep it. `/provider`/`/model` are unadvertised aliases (in `KNOWN`, not `SLASH_COMMANDS` in `src/tui/input.ts`).
- **CLI parity** (`src/cli_providers.ts`): `rocky providers list|login|logout`, `rocky models [provider]`. `models` requires configured provider (registered or env var present), else `ProviderNotFound`.
- **Stored API keys**: `~/.rocky/credentials.json` mode 0600 (`src/config/credentials.ts`). Never in config/history, masked while typed. **Env var named by `apiKeyEnv` always wins.**
- **Session artifacts**: `.rocky/` gitignored via auto-generated `.rocky/.gitignore` (`*`). Holds `broker/` token and `session/<id>/outputs/`.
- **Persisted state**: `~/.rocky/settings.json` (allow/deny grants), `~/.rocky/history` (capped 1000, oldest-first on disk).
- **Project memory**: `ROCKY.md` wins over `AGENTS.md`; only one loaded into `extraSystem`, capped 24KB, unreadable throws (`src/core/memory.ts`).
- **API keys via env vars** named by `provider.apiKeyEnv`/`trueforge.tokenEnv`/`broker.tokenEnv`/worker `credentialEnv` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `TRUEFORGE_TOKEN`, `ROCKY_BROKER_TOKEN`). `OPENAI_API_KEY` backs both `openai` and `openai-compatible`; `ollama` is auth-less. Never log secrets.
- **Worker images** must be pinned (`:tag` != `:latest` or `@sha256:`) — enforced by `isPinnedImage` in `src/config/schema.ts`. Build with explicit `--build-arg` versions (see README). No `opencode.json` in repo — instructions live here.

## Key Conventions

- **Errors are data**: tools return `tool_result` with `is_error: true`; handler throws caught in `loop.ts`.
- **Message types** in `src/core/types.ts`, not `@anthropic-ai/sdk`; providers adapt at boundary.
- **Cache breakpoints**: at most 3, spaced ~12 blocks apart (`src/core/provider/anthropic.ts`). `builtinTools` order frozen; don't reorder/filter per-request.
- **Session is mutable** — known tradeoff (see `DESIGN.md` "What I'd do differently").
- **Slash commands** (`src/tui/input.ts:SLASH_COMMANDS`) single source for `/help`, Tab completion, `unknownCommand` guard. Tab completes commands only, never args.
- **Dialogs**: `DialogRequest` union in `src/tui/app/store.ts` (permission/select/prompt); `pickers.tsx` renders last two. Masked prompt keeps value in plain local, never a signal. Picker ranking: prefix > substring > hint > subsequence.
- **Two REPLs duplicate command tables**: `replFooter` routes via `runSlashCommand`; legacy `repl` handles most inline + delegates whitelist. New command needs wiring in both — `/provider` shares one handler.

## Testing

- Tests in `test/` mirroring `src/`; helpers in `test/helpers.ts` (`tempDir()`, `cleanup()`, `makeCtx()`); mock provider in `test/mock_provider.ts`.
- Integration tests `test/integration/` require live provider.
- Bench tasks `bench/tasks/` use `hidden/` overlays judged post-run; agent must not read them.
- Coverage: SDK event mapping, resume cursors, worker JSON/malformed streams, recovery limits, snapshot exclusions, MCP auth, path traversal/symlink escapes, checkpoints.

## Gotchas

- **`bun test` caches modules**; stale failures → `rm -rf node_modules/.cache`.
- **Ollama probe**: `Provider.prepare()` hits `/api/show` for `contextWindow` + `thinking`; falls back to `DEFAULT_CONTEXT_WINDOW` (126k) on failure. Local `contextWindow` override wins.
- **Compaction** can fire in `-p` mode via fallback policy (`keepMessages: 6`, token budget 20% window); recap enters as tagged `<conversation_summary>` user turn, not system. At most once per `runTurn`.
- **Permissions**: `deny` beats `yolo`; wrapper executables (`sudo`, `env`, `timeout`, …) peeled by suffix matching; `>`/`>>`/`&>` always prompts; `$(...)`/backticks/`eval`/`exec` always prompts. Non-TTY `ask` denies with unblock hint.
- **Post-edit check** (`config.check.command` in `src/core/check.ts`): runs once per batch containing successful `edit_file`/`write_file` from `projectDir`; failure appends `<post_edit_check>` to same user message; broken check (127/126) disables itself after one notice.
- **Interactive vs piped**: `!process.stdin.isTTY` or `-p` means non-interactive — no prompt, answer to stdout, trace to stderr. Esc/Ctrl-C handling differs (OpenTUI raw mode vs `watchKeys`).
- **Console capture**: `src/tui/app/boot.ts` rebinds `console.log` through intercepted `process.stdout.write` while footer is up; direct `console.log` otherwise lands inside footer.

## References

- `DESIGN.md`: architecture tradeoffs, bug history. Read before structural changes.
- `docs/SECURITY.md`, `docs/GENERATED_TOOLS.md`, `docs/DEMO.md`: threat model, generated-tool contract, demo outline.
- `docs/config.example.json`: config template → copy to `.rocky/config.json`.
