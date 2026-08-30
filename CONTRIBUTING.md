# Contributing to Rocky

Rocky is a terminal coding agent that orchestrates disposable workers behind approval and checkpoint boundaries. Because the agent can touch real checkouts, credentials, and containers, contributions are held to a security-first bar. Read [DESIGN.md](DESIGN.md) before any structural change and [docs/SECURITY.md](docs/SECURITY.md) before touching the broker, workspace, permissions, or worker paths.

This guide assumes you are a human contributor. If you are an automated agent acting on a contributor's behalf, also read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) — they spell out the toolchain, conventions, and "do not surprise the user" rules that govern the loop.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Architecture quick map](#architecture-quick-map)
- [Getting set up](#getting-set-up)
- [Development loop](#development-loop)
- [Verification](#verification)
- [Tests](#tests)
- [Conventions that reviewers will check](#conventions-that-reviewers-will-check)
- [Commit messages](#commit-messages)
- [Documentation](#documentation)
- [Reporting bugs and requesting features](#reporting-bugs-and-requesting-features)
- [Pull requests](#pull-requests)
- [Local debugging tips](#local-debugging-tips)
- [Releases](#releases)
- [Reporting security issues](#reporting-security-issues)
- [License](#license)

## Code of conduct

By participating, you agree to keep the project welcoming and technical. Critique code, not people. Assume good faith on ambiguous wording. Surface disagreement on the PR, not the contributor. Maintainers may close or lock threads that drift into personal attacks.

## Architecture quick map

The codebase is small enough to fit in your head. Spend an hour here before opening a PR; reviewers will not re-explain it on every change.

```
src/
  cli.ts                 # entrypoint → Session → Backend → Provider
  core/                  # pure logic: loop, session, types, memory, compact, check
  core/provider/         # 5 provider kinds (anthropic, openai, openai-compatible,
                         #   minimax, ollama) behind stream() / contextWindow() /
                         #   pricing() / prepare()
  backend/               # AgentBackend impls: trueforge (default), local
  broker/                # localhost MCP server on 127.0.0.1:8791, adapters, recovery
  tools/                 # pure (input, ctx) => ToolResult; registry, bash, edit_file,
                         #   read_file, glob, grep, write_file, todo, task
  permissions/           # command parsing, allow/deny/yolo policies, wrapper peel
  workspace/             # snapshot.ts (sanitized), patch.ts (candidate→checkpoint→apply)
  config/                # schema, load (precedence), providers, catalog, credentials
  tui/                   # Solid/OpenTUI footer app; legacy editor under ROCKY_LEGACY_TUI=1
  doctor.ts              # `rocky doctor` preflight (never prints secrets)
test/                    # mirrors src/; helpers in test/helpers.ts, fake provider in
                         #   test/mock_provider.ts; integration/ needs a live provider
bench/                   # bench/run.ts; bench/tasks/ contain hidden overlays not visible
                         #   to the agent under test
docs/                    # SECURITY.md, GENERATED_TOOLS.md, DEMO.md, WRITEUP.md,
                         #   config.example.json, assets/
docker/                  # pinned worker images; rebuilt by CI container-fixture job
patch/                   # pinned dependency overrides
.github/workflows/ci.yml # typecheck → test → container fixture → gitleaks
```

The single most useful file to read is [DESIGN.md](DESIGN.md). The single most useful file to skim is [AGENTS.md](AGENTS.md), which the agent loop itself consumes.

## Getting set up

- Bun 1.4+ is required. Rocky uses `bun run`, `bun test`, and `bunx` — never `npm` or `npx`.
- There is no build step. `package.json:module`/`bin` point directly at `src/cli.ts`.
- Docker is required only if you want to run the `test/broker/container.test.ts` fixture locally; CI runs it for you.

```bash
bun install
bun link                                         # expose the local checkout as `rocky`
cp docs/config.example.json .rocky/config.json   # adjust models and pinned image tags
rocky doctor                                     # preflight; never prints secret values
```

Set only the environment variables named by the providers and worker profiles you enable (`provider.apiKeyEnv`, `trueforge.tokenEnv`, `broker.tokenEnv`, worker `credentialEnv`). Never commit secrets, and never add code that logs their values.

If `rocky doctor` complains about a missing worker image, that is the gate doing its job — the image is built in CI and tagged `:1` precisely so that `:latest` cannot leak in.

## Development loop

```bash
rocky                                                # TrueForge backend (default)
rocky --backend local --provider ollama --model qwen3:8b
rocky -p "fix the failing test"                      # one-shot / non-interactive
```

Session artifacts land in the gitignored `.rocky/` directory. Inspect them when reproducing a bug — checkpoints, candidate patches, broker transcripts, and recovered worker streams all live there.

Useful ad-hoc entry points:

```bash
rocky --tui-smoke                # exercises the OpenTUI footer without a model round-trip
ROCKY_LEGACY_TUI=1 rocky         # hand-rolled editor/keys/status fallback
rocky /provider /model /connect  # picker-driven config wizards (also reachable as /models)
rocky providers list|login|logout
rocky models [provider]
```

## Verification

Every change must pass both gates locally before review. CI is the same two gates plus the container isolation fixture and a gitleaks history scan — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

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

## Tests

- Tests live in `test/` mirroring `src/`. Shared helpers are in `test/helpers.ts` (`tempDir()`, `cleanup()`, `makeCtx()`); the fake provider is `test/mock_provider.ts`.
- Behavior changes need focused tests. Trust boundaries need adversarial tests: path traversal, symlink escapes, stale hashes, malformed worker streams, missing auth, recovery limits, snapshot exclusions.
- `test/integration/` requires a live provider and is not part of the default expectation for a PR. If your change cannot be expressed without a live provider, gate it behind an env flag and document why.
- Benchmark tasks in `bench/tasks/` are judged by `hidden/` overlays applied after the run — do not read or modify those overlays to make a task pass. The bench runner prints a contract verdict; treat a passing contract as necessary, not sufficient.
- Fixtures in `bench/tasks/**/hidden/` and `patches/` exist to be evaluated post-run. Touching them to "fix" a benchmark is a violation of the bench contract, not a fix.

When writing a test:

1. Read the closest existing `*.test.ts` in the same directory to match style (assertion shape, fixture reuse, naming).
2. Drive the function under test through its public boundary; do not reach into private fields.
3. For security-critical paths, add a negative case that fails closed (deny by default, malformed input, expired token, broken symlink, recovery counter exceeded).
4. If the test would be flaky without a clock, network, or filesystem, fake it via the helpers in `test/helpers.ts` rather than reaching for `setTimeout` or live `fetch`.

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

## Commit messages

Subjects follow Conventional Commits. The type is the most important part — it tells reviewers what to expect and tells the changelog writer what bucket to drop the change in.

```
<type>(<scope>): <subject>

<body — wrap at 72 columns; explain what and why, not how>

<footer — references, breaking-change notes, security-review markers>
```

Accepted types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. Scope is the directory or subsystem touched (`broker`, `tui`, `permissions`, `provider/openai`, `workspace`, …) — keep it short.

Conventions:

- Subject in the imperative mood, no trailing period, ≤72 characters.
- Body explains motivation and tradeoffs. "Why this and not that" beats a diff summary.
- Reference issues with `(#123)` and security-relevant changes with `Security:` prefix in the footer.
- Breaking changes append `!` after the type/scope and explain migration in the body.
- Squash fixups before review; the PR's merge commit is not a fixup vehicle.

Examples taken from recent history:

```
fix(credentials): never log the resolved api key, even masked

The previous logger masked the suffix but printed the env var name,
which combined with provider.apiKeyEnv patterns was enough to
enumerate keys. Now we redact at the boundary.

Security: do not regress.
```

```
feat(commands): add /models picker routed through the provider registry

Routes the picker through src/config/providers.ts so it shares the
type-safe wizard used by the non-TTY /connect fallback. Tab
completion still drives off SLASH_COMMANDS.
```

## Documentation

Update the docs that describe what you changed: `README.md` for user-facing flags and flows, `AGENTS.md`/`CLAUDE.md` for agent-facing conventions and commands, `DESIGN.md` for tradeoffs and bug history, `CONTRIBUTING.md` (this file) for contributor workflow, and `docs/SECURITY.md` for anything that shifts the threat model.

If your change introduces a new env var, slash command, or config key, document it in the same PR — not in a follow-up.

## Reporting bugs and requesting features

Open an issue using the GitHub templates. If templates are not available, include:

- **Bug report**: Rocky version (`rocky --version` or `bun run src/cli.ts --version`), commit SHA if built from source, OS, Bun version, the exact command run, the expected vs. observed behavior, and a sanitized transcript. If the bug touches credentials, broker auth, container boundaries, or patch application, treat it as a security issue instead (see below).
- **Feature request**: the user-facing problem, the proposed behavior, the user-visible tradeoffs, and which subsystem it touches (`backend/`, `broker/`, `tools/`, `tui/`, …).
- **Question / support**: the configuration you are running, what you tried, and what happened. The README and `rocky doctor` cover most setup questions.

Before opening a feature request, scan `DESIGN.md` and recent issues — the project often has a documented rationale for the missing affordance.

## Pull requests

- Branch from `main` and keep each PR to one coherent change. Split a refactor from a behavior change; split a behavior change from a doc update unless the doc is the change.
- Run the verification gates locally before requesting review. A red PR is a slow PR.
- In the PR description, state what changed, how you verified it, and any security-relevant surface it touches (broker, workspace, permissions, container, credentials, patch application). Use the Qodo review guidelines in [`.pr_agent.toml`](.pr_agent.toml) as a self-check before submitting.
- PRs are reviewed by Qodo (`.pr_agent.toml`) in addition to a human; expect questions on approval gates, container boundaries, path validation, secret handling, and process cleanup. Reply to Qodo inline comments explicitly; do not silently resolve them.
- Do not merge with a failing typecheck, failing tests, or a red secret scan.
- If your PR touches the bench (`bench/`), call it out in the description and explain whether you expect the contract verdict to change.
- Squash fixups before the final review. After approval, the maintainer will merge.

A PR template that covers the high-signal fields:

```markdown
## What changed
- …

## How I verified
- [ ] `bunx tsc --noEmit`
- [ ] `bun test`
- [ ] `bun test --changed`
- [ ] (if applicable) `ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts`
- [ ] (if applicable) `bun bench/run.ts`

## Security-relevant surface
- broker / workspace / permissions / container / credentials / patch application / none

## Notes for the reviewer
- …
```

## Local debugging tips

- **Stale `bun test` failures.** Clear the module cache: `rm -rf node_modules/.cache`. Bun caches compiled modules aggressively.
- **OpenTUI footer renders blank.** You are probably hitting the React transform. Confirm `bunfig.toml` still loads `@opentui/solid/preload`; do not remove it.
- **Vendored `opencode/` tests ran and failed.** The `[test] root = "test"` setting in `bunfig.toml` exists to prevent this. If they run, the setting is gone — restore it.
- **Ollama probe fails in `Provider.prepare()`.** It calls `/api/show` for `contextWindow` and `thinking`. A failure falls back to `DEFAULT_CONTEXT_WINDOW` (126k) and disables thinking — check whether the model actually exposes those fields, then set a local `contextWindow` override in your config.
- **`rocky doctor` complains about the worker image.** Build it locally (`docker/workers/Dockerfile.base` then `Dockerfile.fixture`) or set `ROCKY_CONTAINER_TEST=1` only in CI where the images are built for you.
- **Session is locked / artifacts look weird.** Inspect `.rocky/session/<id>/` for candidate patches and checkpoints; `undoWorkspacePatch` only rolls back the last applied patch.
- **Bun acts differently from Node.** Use `bun`, not `node`, for both runtime and tooling. `bun --bun rocky` forces Bun to be the runtime if a global `node` is winning `PATH`.
- **A test passes locally but fails on a clean checkout.** Check for hidden state under `.rocky/` (gitignored) or `node_modules/.cache`. CI runs on a clean checkout; if your test relies on prior state, it is not hermetic.

## Releases

Rocky does not have a published release cadence; tags are cut when a meaningful checkpoint lands. The rules:

- `main` is always green. Force-pushes to `main` are not used; roll forward instead.
- Versioning follows semver. Breaking changes bump the minor version until 1.0 and the major version after.
- Tags and GitHub release notes are produced by the maintainer; contributors do not cut releases from their own branches.
- The bench contract is part of the release gate — a release that breaks an existing bench task needs an explicit decision recorded in the PR.

## Reporting security issues

Do not open a public issue for a vulnerability in the approval, broker, container, or patch-application path. Report it privately to the maintainer first, including reproduction steps and impact. See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and disclosure scope.

## License

Contributions are accepted under the [MIT License](LICENSE).
