# Rocky — Agent Instructions

## Commands

- **Run (TrueForge default)**: `bun run src/cli.ts`
- **Run local loop**: `bun run src/cli.ts --backend local --provider ollama --model qwen3:8b`
- **One-shot**: `bun run src/cli.ts -p "fix the failing test"` (piped stdin also triggers non-interactive mode)
- **Verify setup**: `bun run src/cli.ts doctor` (TrueForge/Daytona/broker/Docker/workers)
- **Broker standalone**: `bun run src/cli.ts broker` (bearer-auth on 127.0.0.1; reused if already running)
- **Typecheck**: `bunx tsc --noEmit` (`lint` alias is same; no separate linter)
- **Test all**: `bun test`
- **One file**: `bun test test/path/to/file.test.ts` (path must contain `.test.` / `_test_` / `.spec.`; pass `./foo.test.ts` if Bun treats it as a filter)
- **One test**: `bun test test/path/file.test.ts -t "regex"` (Bun's name-pattern flag is `-t` / `--test-name-pattern` — `--filter` is a Jest-ism and silently no-ops)
- **Only changed tests**: `bun test --changed` (compared against HEAD by default)
- **Container fixture**: `ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts` (requires the locally-built `rocky-worker-fixture:1` image — see README "Worker images")
- **Bench**: `bun bench/run.ts` (not via `bun test`; `bench/tasks/` is excluded from typecheck because hidden/ overlays only resolve post-run)

## Runtime & Toolchain

- **Bun, not Node.** Use `bun run`, `bun test`, `bunx`. No `npm`/`npx`.
- **No build step.** Source runs directly via `bun run src/cli.ts`; `package.json:module/bin` point at `src/cli.ts`.
- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess` — typecheck fails on unused vars/params.
- **Solid JSX**: `bunfig.toml` preloads `@opentui/solid/preload` — required for `src/tui/app/*.tsx` Solid reactivity; don't remove.
- **Test isolation**: `bunfig.toml` sets `[test] root = "test"` — prevents vendored `opencode/` tests from running. `tsconfig.json` excludes `bench/tasks`.
- **Patched dep**: `@opentui/core@0.4.5` is patched (`patches/@opentui%2Fcore@0.4.5.patch`) to parse SGR into styled spans for `capture-stdout` scrollback.

## Architecture

- **Entry**: `src/cli.ts` → `Session` (`src/core/session.ts`) → `Backend` (`src/backend/`) → `Provider` (`src/core/provider/`)
  - `backend: "trueforge"` (default) owns streaming, SSE reconnect, Daytona, MCP broker. `backend: "local"` uses `runTurn()` direct to provider.
- **Loop** (`src/core/loop.ts`): pure, yields `LoopEvent`s; no I/O, no globals, never throws for tool failures.
- **Backends** (`src/backend/trueforge.ts`, `src/backend/local.ts`) behind `AgentBackend` interface (`turn()`, `cancel()`, `status()`, `sessions()`).
- **Broker** (`src/broker/`): localhost MCP server on `127.0.0.1:8791`, bearer token in `.rocky/broker`, adapters per worker kind in `adapters.ts`, recovery policy in `recovery.ts` (max 3 attempts).
- **Tools** (`src/tools/`): pure `(input, ctx) => ToolResult`; read-only run parallel, mutating serialize; always yield one `tool_result` per `tool_use`.
- **Providers** (`src/core/provider/`): 5 kinds (`anthropic`, `openai`, `openai-compatible`, `minimax`, `ollama`) behind `stream()`/`contextWindow()`/`pricing()`/`prepare()`.
- **TUI** (`src/tui/`): streaming markdown + lexer highlighting. `src/tui/app/` is the Solid/OpenTUI footer app (`screenMode: "split-footer"`, `capture-stdout`). Scrollback is plain terminal; footer owns editor/status/spinner/dialog. `ROCKY_LEGACY_TUI=1` falls back to hand-rolled `editor.ts`/`keys.ts`/`status.ts`. Hidden harness: `bun run src/cli.ts --tui-smoke`.
- **Workspace** (`src/workspace/`): `snapshot.ts` (sanitized, size-limited) + `patch.ts` (candidate patch → checkpoint → apply, `undoWorkspacePatch`).

## Config & Environment

- **Config precedence** (low→high, `src/config/load.ts:49`): defaults → `~/.config/rocky/config.json` → `.rocky/config.json` → CLI flags. `provider`/`trueforge`/`broker` merge one level deep.
- **Example**: `docs/config.example.json` → copy to `.rocky/config.json`.
- **Session artifacts**: `.rocky/` (gitignored via auto-generated `.rocky/.gitignore` containing `*`). Also holds `broker/` token and archived tool outputs (`session/<id>/outputs/`).
- **Persisted grants/history**: `~/.rocky/settings.json` (allow/deny grants), `~/.rocky/history` (capped 1000, oldest-first on disk).
- **Project memory**: `ROCKY.md` wins over `AGENTS.md`; only one loaded into `extraSystem`, capped 24KB, unreadable file throws (don't silently ignore). See `src/core/memory.ts`.
- **API keys**: via env vars named by `provider.apiKeyEnv` / `trueforge.tokenEnv` / `broker.tokenEnv` / worker `credentialEnv` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `TRUEFORGE_TOKEN`, `ROCKY_BROKER_TOKEN`). The same `OPENAI_API_KEY` backs both `openai` and `openai-compatible`; `ollama` is auth-less. Never log secret values; `doctor` is safe to run.
- **Worker images**: must be pinned (`:tag` != `:latest` or `@sha256:` digest) — enforced by `WorkerProfileSchema` `isPinnedImage` (`src/config/schema.ts:11`). Build with explicit `--build-arg` versions (see `README.md` Worker images).

## Key Conventions

- **Errors are data**: tools return `tool_result` with `is_error: true`; tool handler throws are caught and converted in `loop.ts`.
- **Message types** in `src/core/types.ts`, not from `@anthropic-ai/sdk`; providers adapt at boundary.
- **Tool registry** uses `erase()` type erasure, not `any`; Zod validates untrusted model input at boundary (`src/tools/index.ts`).
- **Cache breakpoints**: at most 3, spaced ~12 blocks apart (`src/core/provider/anthropic.ts`). `builtinTools` order is frozen; don't reorder/filter per-request.
- **Session is mutable** — known tradeoff (see `DESIGN.md` "What I'd do differently").
- **Slash commands** (`src/tui/input.ts:SLASH_COMMANDS`) are single source for `/help`, Tab completion, and `unknownCommand` guard. Tab completes commands only, never args.

## Testing

- Tests in `test/` mirroring `src/`; helpers in `test/helpers.ts` (`tempDir()`, `cleanup()`, `makeCtx()`); mock provider in `test/mock_provider.ts`.
- Integration tests `test/integration/` require live provider.
- Bench tasks `bench/tasks/` use `hidden/` overlays judged post-run; agent must not read them.
- Coverage includes SDK event mapping, resume cursors, worker JSON/malformed streams, recovery limits, snapshot exclusions, MCP auth, path traversal/symlink escapes, checkpoints.

## Gotchas

- **`bun test` caches modules**; stale failures → `rm -rf node_modules/.cache`.
- **Ollama probe**: `Provider.prepare()` hits `/api/show` at startup for `contextWindow` + `thinking` capability; falls back to `DEFAULT_CONTEXT_WINDOW` (126k) on failure. Local `contextWindow` override wins.
- **Compaction** can fire in `-p` mode via fallback policy (`keepMessages: 6`, token budget 20% window); recap enters as tagged `<conversation_summary>` user turn, not system. At most once per `runTurn`.
- **Permissions**: `deny` beats `yolo`; wrapper executables (`sudo`, `env`, `timeout`, …) are peeled by suffix matching; `>`/`>>`/`&>` redirection always prompts; `$(...)`/backticks/`eval`/`exec` always prompts. Non-TTY `ask` denies with unblock hint.
- **Post-edit check** (`config.check.command`) runs once per batch containing successful `edit_file`/`write_file` from `projectDir`; failure appends `<post_edit_check>` to same user message; broken check (127/126) disables itself after one notice (`src/core/check.ts`).
- **Interactive vs piped**: `!process.stdin.isTTY` or `-p` means non-interactive — no prompt, answer to stdout, trace to stderr. Esc/Ctrl-C handling differs (OpenTUI holds raw mode vs `watchKeys`).
- **Console capture**: `src/tui/app/boot.ts` rebinds `console.log` through intercepted `process.stdout.write` while footer is up; direct `console.log` otherwise lands inside footer.

## References

- `DESIGN.md`: architecture tradeoffs, bug history, why each decision was made. Read before structural changes.
- `docs/SECURITY.md`, `docs/GENERATED_TOOLS.md`, `docs/DEMO.md`: threat model, generated-tool contract, demo recording outline.
