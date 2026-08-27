# Rocky

Rocky is a terminal coding agent whose specialty is orchestration. TrueForge owns the root agent loop, durable sessions, dynamic subagents, MCP, Daytona sandboxing, compaction, and human approvals. Rocky selects disposable Codex, Claude Code, or OpenCode workers, validates their candidate patches away from the user's checkout, recovers from failures, and stops before consequential workspace changes.

This implementation targets the [TrueForge hackathon rules](https://www.wemakedevs.org/hackathons/trueforge/rules) and uses the official [`@truefoundry/trueforge-sdk`](https://github.com/truefoundry/trueforge/tree/main/packages/trueforge-sdk).

```text
Rocky OpenTUI
    │ TrueForge SDK — sessions, SSE turns, approvals, reconnect
    ▼
TrueForge root agent
    ├── dynamic subagents
    ├── Daytona inspection and independent validation
    └── localhost Rocky MCP worker broker
           ├── Codex container
           ├── Claude Code container
           └── OpenCode container

candidate patch → Daytona checks → TrueForge approval → checkpointed workspace apply
```

## Hackathon disclosure

Rocky's original local provider loop and terminal UI existed before the TrueForge hackathon. The TrueForge backend, SSE normalization/reconnect, worker broker and adapters, sanitized snapshots, hardened containers, candidate patch/checkpoint workflow, bounded recovery primitives, generated-tool policy, orchestration UI, doctor command, and this security/demo material are hackathon-period work. AI coding assistants were used during implementation and review.

## Requirements

- Bun 1.4+
- TrueForge 0.1.x running locally or at a configured URL
- A TrueForge model provider and Daytona sandbox
- Docker for external workers
- At least one worker provider credential for delegation

Install dependencies with `bun install`. Copy [docs/config.example.json](docs/config.example.json) to `.rocky/config.json`, adjust model/image tags, and set only the environment variables named by each enabled worker profile.

## Run

```bash
# Full preflight; does not reveal secret values
bun run src/cli.ts doctor

# TrueForge orchestration backend (default)
bun run src/cli.ts
bun run src/cli.ts -p "fix the failing test"

# Original Rocky loop
bun run src/cli.ts --backend local --provider ollama --model qwen3:8b

# Optional standalone broker (Rocky securely reuses it when already running)
bun run src/cli.ts broker
```

On the TrueForge path Rocky starts the bearer-authenticated broker on `127.0.0.1`, registers or updates the configured MCP connector through the official TypeScript SDK, creates or resumes a TrueForge session, attaches the first sanitized workspace snapshot, and maps SDK events into the existing renderer. Escape cancels the TrueForge session. Stream disconnects resume with `subscribeToTurn` and the persisted sequence cursor.

Interactive commands include `/sessions`, `/workers`, `/worker <name|auto>`, `/sandbox`, `/heal`, `/diff`, `/undo`, `/doctor`, plus the original model, cost, compact, permissions, plan, history, and output commands. `@codex`, `@claude`, and `@opencode` remain direct prompt overrides.

## Worker images

Every CLI version is an explicit build argument; never use `latest`.

```bash
docker build -f docker/workers/Dockerfile.base -t rocky-worker-base:1 .
docker build -f docker/workers/Dockerfile.codex \
  --build-arg ROCKY_WORKER_BASE=rocky-worker-base:1 \
  --build-arg CODEX_VERSION=<pin> -t rocky-worker-codex:<pin> .
docker build -f docker/workers/Dockerfile.claude \
  --build-arg ROCKY_WORKER_BASE=rocky-worker-base:1 \
  --build-arg CLAUDE_CODE_VERSION=<pin> -t rocky-worker-claude:<pin> .
docker build -f docker/workers/Dockerfile.opencode \
  --build-arg ROCKY_WORKER_BASE=rocky-worker-base:1 \
  --build-arg OPENCODE_VERSION=<pin> -t rocky-worker-opencode:<pin> .

# Credential-free integration fixture
docker build -f docker/workers/Dockerfile.fixture \
  --build-arg ROCKY_WORKER_BASE=rocky-worker-base:1 \
  -t rocky-worker-fixture:1 .
ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts
```

Workers run non-interactively and receive neither the host checkout nor Docker socket. Codex uses JSONL, ephemeral sessions, and workspace-write sandboxing; Claude uses streaming JSON print mode; OpenCode uses JSON run mode. Malformed streams fall back to plain-text normalization and count as adapter-health regressions.

## Safety and recovery

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model. Automated recovery is capped at three worker attempts. Authentication and configuration errors stop with setup guidance; timeout/crash gets one reduced retry before switching; malformed event streams use a text fallback; invalid patches and failed Daytona checks get one evidence-backed repair attempt.

Generated Daytona helpers follow the session-only [generated-tool contract](docs/GENERATED_TOOLS.md): a manifest, restricted entrypoint, and passing smoke test are mandatory, and generated code never loads into Rocky's host process.

Rocky source self-repair is diagnostic-only until ordinary recovery fails. Its patch must pass `bun test` and `bunx tsc --noEmit` in Daytona, cross the same approval/checkpoint boundary, and requires a restart—Rocky never hot-loads self-generated code.

## Verification

```bash
bunx tsc --noEmit
bun test

# Optional live-model benchmark (three trials per task by default)
ROCKY_BENCH_TRIALS=3 bun bench/run.ts
```

Benchmark limits are configurable with `ROCKY_BENCH_TIMEOUT_MS` (default 10 minutes per complete trial), `ROCKY_BENCH_VERIFY_TIMEOUT_MS` (default 2 minutes), and `ROCKY_BENCH_VERIFY_OUTPUT_BYTES` (default 128 KiB).

The suite covers SDK event mapping, approvals and resume, reconnect cursors, worker JSON parsers and malformed streams, recovery classification/limits, snapshot exclusions and size limits, MCP authentication, path traversal, symlink escapes, stale hashes, conflicts, checkpoints, undo conflicts, and the original agent/TUI/provider behavior. The benchmark runs the real loop in disposable repositories behind a workspace-only tool boundary: model-controlled shells and subagents are disabled, and file tools reject absolute, traversal, and symlink escapes. Hidden acceptance checks are overlaid only after the agent stops; bounded external verification, not model claims, decides the score.

The recording outline is in [docs/DEMO.md](docs/DEMO.md).

## License

Rocky is available under the [MIT License](LICENSE).
