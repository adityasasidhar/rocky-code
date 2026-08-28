# Contributing to Rocky

Rocky is a terminal coding agent that orchestrates disposable workers behind approval and checkpoint boundaries. Because the agent can touch real checkouts, credentials, and containers, contributions are held to a security-first bar. Read [DESIGN.md](DESIGN.md) before any structural change and [docs/SECURITY.md](docs/SECURITY.md) before touching the broker, workspace, permissions, or worker paths.

## Getting set up

- Bun 1.4+ is required. Rocky uses `bun run`, `bun test`, and `bunx` — never `npm` or `npx`.
- There is no build step. `package.json:module`/`bin` point directly at `src/cli.ts`.

```bash
bun install
cp docs/config.example.json .rocky/config.json   # adjust models and pinned image tags
bun run src/cli.ts doctor                        # preflight; never prints secret values
```

Set only the environment variables named by the providers and worker profiles you enable (`provider.apiKeyEnv`, `trueforge.tokenEnv`, `broker.tokenEnv`, worker `credentialEnv`). Never commit secrets, and never add code that logs their values.

## Development loop

```bash
bun run src/cli.ts                                   # TrueForge backend (default)
bun run src/cli.ts --backend local --provider ollama --model qwen3:8b
bun run src/cli.ts -p "fix the failing test"         # one-shot / non-interactive
```

Session artifacts land in the gitignored `.rocky/` directory.

## Verification

Every change must pass both gates locally before review:

```bash
bunx tsc --noEmit   # `bun run lint` is the same command; there is no separate linter
bun test
```

Useful narrower runs:

```bash
bun test test/loop.test.ts                  # path must contain .test. / .spec.
bun test test/loop.test.ts -t "regex"       # Bun's name filter is -t, not --filter
bun test --changed                          # only tests changed vs HEAD
bun bench/run.ts                            # live-model benchmark, not run via bun test
ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts   # needs rocky-worker-fixture:1
```

TypeScript runs strict with `noUnusedLocals`, `noUnusedParameters`, and `noUncheckedIndexedAccess`, so unused variables and parameters fail the typecheck. If `bun test` reports stale failures, clear the module cache with `rm -rf node_modules/.cache`.

CI runs the same typecheck and test suite, plus the container isolation fixture and a gitleaks history scan.

## Tests

- Tests live in `test/` mirroring `src/`. Shared helpers are in `test/helpers.ts` (`tempDir()`, `cleanup()`, `makeCtx()`); the fake provider is `test/mock_provider.ts`.
- Behavior changes need focused tests. Trust boundaries need adversarial tests: path traversal, symlink escapes, stale hashes, malformed worker streams, missing auth, recovery limits.
- `test/integration/` requires a live provider and is not part of the default expectation for a PR.
- Benchmark tasks in `bench/tasks/` are judged by `hidden/` overlays applied after the run — do not read or modify those overlays to make a task pass.

## Conventions that reviewers will check

- **Errors are data.** Tools return a `tool_result` with `is_error: true`; `src/core/loop.ts` converts handler throws rather than propagating them. The loop stays pure: no I/O, no globals, and it never throws for tool failures.
- **Exactly one `tool_result` per `tool_use`.** Read-only tools may run in parallel; mutating tools serialize.
- **Message types come from `src/core/types.ts`**, not from `@anthropic-ai/sdk`. Providers adapt at their own boundary.
- **Validate untrusted model input with Zod** at the tool registry boundary (`src/tools/index.ts`), and use `erase()` for type erasure instead of `any`.
- **Keep the backend interface provider-neutral.** New behavior belongs behind `AgentBackend` (`turn()`, `cancel()`, `status()`, `sessions()`), not sprinkled through the TUI.
- **Nothing mutates the user's checkout before approval.** Candidate patch → TrueForge approval → checkpoint → apply, with `undoWorkspacePatch` available.
- **Worker images must be pinned.** `:latest` is rejected by `WorkerProfileSchema` (`src/config/schema.ts`); build with explicit `--build-arg` versions as documented in the README.
- **Do not reorder `builtinTools`** or change the Anthropic cache-breakpoint scheme (at most 3, spaced ~12 blocks apart) without reading the rationale in `DESIGN.md`.
- **Slash commands** are defined once in `src/tui/input.ts:SLASH_COMMANDS`, which also drives `/help`, Tab completion, and the unknown-command guard.
- **Do not remove `@opentui/solid/preload`** from `bunfig.toml` or the `[test] root = "test"` setting; the first is required for Solid reactivity, the second keeps the vendored `opencode/` tests from running.
- New generated tooling must follow the session-only [generated-tool contract](docs/GENERATED_TOOLS.md): manifest, restricted entrypoint, passing smoke test, and never loaded into the host process.

Code in this repo is comment-light by design. Prefer clear names and small functions over explanatory comments.

## Documentation

Update the docs that describe what you changed: `README.md` for user-facing flags and flows, `AGENTS.md`/`CLAUDE.md` for agent-facing conventions and commands, `DESIGN.md` for tradeoffs and bug history, and `docs/SECURITY.md` for anything that shifts the threat model.

## Pull requests

- Branch from `main` and keep each PR to one coherent change.
- Commit subjects follow the existing Conventional-Commit style: `feat:`, `fix:`, `perf:`, `chore:`, `ci:`.
- In the PR description, state what changed, how you verified it, and any security-relevant surface it touches.
- PRs are reviewed by Qodo (`.pr_agent.toml`) in addition to a human; expect questions on approval gates, container boundaries, path validation, secret handling, and process cleanup.
- Do not merge with a failing typecheck, failing tests, or a red secret scan.

## Reporting security issues

Do not open a public issue for a vulnerability in the approval, broker, container, or patch-application path. Report it privately to the maintainer first, including reproduction steps and impact.

## License

Contributions are accepted under the [MIT License](LICENSE).
