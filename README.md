<div align="center">

```
╭────────────────────────────────────────────────────────────────────────╮
│   ▄▟███▙▄     rocky v0.1.0  ♫ Amaze!                                   │
│  ▐███████▌    trueforge/root-agent · trueforge                         │
│   ▀▜███▛▀     orchestrate · ~/projects/api-server                      │
│   ╱╱ ┃ ╲╲     /help for commands · Esc interrupts · Ctrl-C twice exits │
╰────────────────────────────────────────────────────────────────────────╯
```

# Rocky

**A terminal coding agent that never lets another agent touch your code.**

Rocky hires Codex, Claude Code, and OpenCode as disposable contractors, keeps them
in sealed containers that have never seen your checkout, and refuses to believe a
word they say until TrueForge has proved it in a sandbox and you have said yes.

[![CI](https://github.com/adityasasidhar/rocky-code/actions/workflows/ci.yml/badge.svg)](https://github.com/adityasasidhar/rocky-code/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-773%20passing-2ea043)](#verification)
[![typecheck](https://img.shields.io/badge/tsc-strict%20%C2%B7%20clean-2ea043)](#verification)
[![runtime](https://img.shields.io/badge/runtime-Bun%201.4-f472b6)](https://bun.sh)
[![harness](https://img.shields.io/badge/harness-TrueForge%200.1.x-6366f1)](https://github.com/truefoundry/trueforge)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

## The problem

Every coding agent on the market ends its turn the same way: it writes to your
working tree and tells you it worked. You find out otherwise later. The model that
wrote the patch is also the only witness to whether the patch is good — and it is
the *least* reliable witness you could pick, because "I fixed it" is the cheapest
token sequence in the distribution.

Stack a second agent on top and it gets worse, not better. Now you have two models
agreeing with each other over a checkout neither of them is accountable for.

## The answer

Rocky separates **who writes the patch** from **who is allowed to believe it**.

```text
Rocky OpenTUI
    │ TrueForge SDK — sessions, SSE turns, approvals, reconnect
    ▼
TrueForge root agent          ← plans, delegates, never writes
    ├── dynamic subagents
    ├── Daytona sandbox        ← the only thing allowed to say "it passed"
    └── localhost MCP broker   ← bearer-auth, 127.0.0.1 only
           ├── Codex container       ┐
           ├── Claude Code container ├─ disposable · read-only rootfs · no checkout
           └── OpenCode container    ┘

  candidate patch → Daytona validation → TrueForge approval → checkpointed apply
       (a claim)        (the evidence)      (your decision)     (reversible)
```

Four properties fall out of that boundary, and they are the whole project:

| | |
|---|---|
| **Workers never see your repo.** | Each gets a separately extracted, secret-scrubbed snapshot copy. Not a bind mount. Not the Docker socket. A copy. |
| **Worker claims are not results.** | The patch goes to a fresh Daytona sandbox and the project's own checks run there. Rocky reports what Daytona found, next to what the worker claimed. |
| **Nothing mutates without you.** | `workspace_apply_patch` and `workspace_undo` are declared destructive; TrueForge halts the turn on both. |
| **Every apply is reversible.** | Pre-images are checkpointed before an atomic write. `/undo` restores them — and refuses if you have edited the file since. |

Rocky's own source code gets no exemption. When Rocky patches Rocky, the patch
crosses the same sandbox, the same approval, and the same checkpoint — and then
requires a **restart**. Rocky never hot-loads code it wrote.

---

## Quickstart

```bash
git clone https://github.com/adityasasidhar/rocky-code && cd rocky-code
bun install

cp docs/config.example.json .rocky/config.json   # set models + pinned image tags
bun run src/cli.ts doctor                        # preflight; never prints secrets
bun run src/cli.ts                               # go
```

`doctor` is the first thing to run and the first thing to show a skeptic. Every
line below is a check it actually performs, shown here with workers enabled:

```console
$ bun run src/cli.ts doctor
✓ TrueForge            200 OK
✓ root model           claude-opus-4-8
✓ Daytona sandbox      enabled in the TrueForge agent spec
✓ Docker               29.7.2
✓ worker codex         codex · rocky-worker-codex:0.48.0
✓ codex credentials    1 required variable(s) present
✓ worker broker        authenticated MCP ping succeeded · bearer token configured
✓ Git workspace        /home/you/projects/api-server
✓ snapshot safety      158 files · 0.9 MiB · secrets excluded
```

It reports *presence*, never values. There is no invocation of `doctor` that
prints a secret.

**Requirements** — Bun 1.4+, TrueForge 0.1.x (local or remote), a TrueForge model
provider with Daytona enabled, Docker for workers, and at least one worker
credential. Secrets are supplied only through environment variables *named* by
config (`provider.apiKeyEnv`, `trueforge.tokenEnv`, `broker.tokenEnv`, worker
`credentialEnv`) — a literal key in a config file is a schema error, not a warning.

### Other ways to run it

```bash
bun run src/cli.ts -p "fix the failing test"    # one-shot; piped stdin does this too
bun run src/cli.ts --backend local \
  --provider ollama --model qwen3:8b            # Rocky's original single-model loop
bun run src/cli.ts broker                       # standalone broker; reused if already up
```

---

## What a run looks like

The orchestration is not hidden behind a spinner. Every delegation, every
validation, and every disagreement between a worker and the sandbox is on screen.
The session below is illustrative — it shows the shape of a real run, not a
captured benchmark:

```console
› the auth middleware drops the refresh token on 401 retry

⏺ planning
  ⎿ snapshot attached · 158 files · 0.9 MiB

⏺ worker_recommend(auth middleware · typescript · 3 files)
  ⎿ codex — strongest on narrow, test-anchored TypeScript fixes
     claude — fallback; opencode — image unavailable

⏺ worker_start(codex · rocky-worker-codex:0.48.0)
  ⎿ container up · workspace copy extracted · no host mount

⏺ worker_result(codex)
  ⎿ candidate patch · 2 files · +14 −6
     worker claims: "fixed, tests pass"        ← a claim

⏺ validating — Daytona · bun test
  ⎿ 1 failed — refresh token still cleared on the second 401   ← the evidence
     the worker's claim did not survive validation

⏺ worker_start(codex · repair attempt 2 of 3)
  ⎿ failing output attached as evidence

⏺ validating — Daytona · bun test
  ⎿ 214 pass · 0 fail

⏺ workspace_apply_patch — approval required
  ⎿ src/auth/middleware.ts  +9 −4
     test/auth/refresh.test.ts  +11 −0
     validated in Daytona · destination /home/you/projects/api-server
     [a]pprove  [d]eny  [v]iew diff
```

The fifth block is the point of the whole project. A worker said it was done. It
was not done. Rocky found out **before** your files were touched, and spent a
retry on it instead of spending your afternoon.

Interactive commands: `/sessions` `/workers` `/worker <name|auto>` `/sandbox`
`/heal` `/diff` `/undo` `/doctor` `/plan` `/cost` `/compact` `/model` `/expand`
`/permissions` `/info` `/history` `/help`. `@codex`, `@claude`, and `@opencode`
force a worker inline for one prompt.

---

## How TrueForge is used

TrueForge is not a model call behind a wrapper here. Rocky hands it the root agent
loop and keeps only the parts a terminal has to own.

| TrueForge owns | Rocky owns |
|---|---|
| Root agent loop, planning, tool selection | Terminal UI, scrollback, footer, key handling |
| Durable sessions and turn history | Workspace snapshotting and secret exclusion |
| SSE turn streaming and reconnect | Worker broker, container lifecycle, adapters |
| Dynamic subagents | Candidate-patch → checkpoint → apply pipeline |
| Daytona sandbox provisioning and validation | Bounded recovery policy and failure classification |
| Human approval gates on destructive tools | Mapping SDK events into one renderer |

Concretely, through the official [`@truefoundry/trueforge-sdk`](https://github.com/truefoundry/trueforge/tree/main/packages/trueforge-sdk):

- **Agent spec** declares `requireApprovalForTools: ["workspace_apply_patch", "workspace_undo", "worker_cancel"]` and `preloadTools: ["worker_list", "worker_recommend"]`. The approval boundary is configuration TrueForge enforces, not a prompt Rocky hopes the model respects.
- **Sessions persist** under `.rocky/trueforge/` with the session id, active turn, snapshot attachment state, and SSE sequence cursor. Kill Rocky mid-turn, restart, run `/sessions`, and the turn replays from the cursor via `subscribeToTurn`.
- **The MCP connector** is registered and updated through the SDK against the localhost broker, so TrueForge's own tool-calling machinery drives the workers. There is no side channel.
- **Escape cancels the server session**, not just the local render — interruption is a real state transition upstream.
- **Every SDK event normalizes into one `LoopEvent` stream**, which is why `--backend local` and the TrueForge path share a renderer and the UI never learns which one is running.

The broker exposes eight MCP tools — `worker_list`, `worker_recommend`,
`worker_start`, `worker_status`, `worker_result`, `worker_cancel`,
`workspace_apply_patch`, `workspace_undo` — behind a 256-bit bearer token on
`127.0.0.1`, with runs recorded in SQLite.

### When things go wrong

Recovery is bounded and classified, never a retry loop (`src/broker/recovery.ts`):

| Failure | Response |
|---|---|
| Auth / config error | **Stop** with setup guidance. Retrying a missing key is theatre. |
| Timeout or crash | One reduced retry, then switch worker |
| Malformed event stream | Plain-text fallback, counted as an adapter-health regression |
| Invalid patch / failed Daytona check | One repair attempt, with the failing output attached as evidence |
| — | Hard ceiling of **3** attempts, then hand back to the human |

---

## The interface

Rocky's TUI is an OpenTUI **split-footer**: scrollback stays real terminal output
you can select, pipe, and scroll natively, while a Solid-rendered footer owns the
editor, status line, spinner, and approval dialogs.

- **Streaming markdown**, rendered character by character rather than line by line, so a long answer never arrives in a block.
- **A syntax highlighter that is a lexer**, not a pile of regexes — keyword, type, number, string, comment, function, and punctuation classes painted correctly inside fences.
- **Tool calls draw as `⏺ name(args)`** with results hanging off a `⎿` elbow. Headers are always one line; `/expand <n>` reprints a collapsed result in full.
- **Silence has a face.** The two stretches where nothing streams show a spinner with a rotating verb, a live elapsed clock, and `esc to interrupt` — and it yields to permission prompts instead of erasing the question every 80ms.
- **Type-ahead survives.** Text typed during a running turn is buffered; completed lines queue as prompts, the unfinished tail prefills the editor.
- **The banner is a pure function** of its inputs, so the alignment math is unit-tested — every row the same visible width, `…` truncation rather than a broken frame, and a plain-line fallback under 44 columns.

Rocky is the Eridian from *Project Hail Mary*: rock carapace, five radial legs,
no eyes — Eridians perceive by sound, hence the `♫`. Personality lives at the
edges (banner, idle verbs, the `♫ fist my bump` sign-off) and never in the
transcript, which stays strictly informational.

`ROCKY_LEGACY_TUI=1` falls back to the hand-rolled renderer.

---

## Safety

The full threat model is in [docs/SECURITY.md](docs/SECURITY.md). In short:

1. Snapshots exclude `.git`, `.rocky`, dependencies, build output, `.env*`, credentials, private keys, and configured secret globs. A SHA-256 manifest anchors the baseline; the default cap is 50 MiB.
2. Worker containers run a **read-only root**, a writable disposable workspace, a bounded tmpfs, dropped capabilities, `no-new-privileges`, and CPU/memory/PID limits. Only explicitly listed credential variables enter the selected container.
3. Apply rejects absolute paths, traversal, symlink crossings, binaries, stale hashes, and patch conflicts — then checkpoints pre-images before an atomic write.
4. Undo refuses to overwrite files changed after application.
5. Logs redact forwarded credentials and common token formats.
6. Generated Daytona helpers follow the session-only [generated-tool contract](docs/GENERATED_TOOLS.md) — manifest, restricted entrypoint, mandatory passing smoke test, and **never loaded into Rocky's host process**.

Worker images must be pinned. `:latest` is rejected at config-validation time, not
at runtime:

```bash
BASE=rocky-worker-base:1
docker build -f docker/workers/Dockerfile.base -t $BASE .

docker build -f docker/workers/Dockerfile.codex --build-arg ROCKY_WORKER_BASE=$BASE \
  --build-arg CODEX_VERSION=0.150.1     -t rocky-worker-codex:0.150.1 .
docker build -f docker/workers/Dockerfile.claude --build-arg ROCKY_WORKER_BASE=$BASE \
  --build-arg CLAUDE_CODE_VERSION=2.1.250 -t rocky-worker-claude:2.1.250 .
docker build -f docker/workers/Dockerfile.opencode --build-arg ROCKY_WORKER_BASE=$BASE \
  --build-arg OPENCODE_VERSION=1.18.25  -t rocky-worker-opencode:1.18.25 .

# Credential-free isolation fixture, used by CI
docker build -f docker/workers/Dockerfile.fixture \
  --build-arg ROCKY_WORKER_BASE=$BASE -t rocky-worker-fixture:1 .
ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts
```

The version in the tag is the version inside the image — the build fails if the
`--build-arg` is missing, and the config schema rejects the resulting tag if it
is `latest`. [`docs/config.example.json`](docs/config.example.json) pins exactly
these tags.

---

## Verification

```bash
bunx tsc --noEmit   # strict, plus noUnusedLocals/Parameters/UncheckedIndexedAccess
bun test            # 773 pass · 1 skip · 0 fail · 44 files · ~3.5s
```

CI runs both on every PR, plus the container isolation fixture and a gitleaks
scan of the full history.

The suite is deliberately adversarial where it matters: SDK event mapping,
approvals and resume, reconnect cursors, worker JSON parsers **and malformed
streams**, recovery classification and limits, snapshot exclusions and size
limits, MCP authentication, path traversal, symlink escapes, stale hashes,
conflicts, checkpoints, and undo conflicts.

Beyond unit tests, `bench/` runs the **real loop** in disposable repositories
behind a workspace-only tool boundary — model-controlled shells and subagents
disabled, file tools rejecting absolute/traversal/symlink escapes. Hidden
acceptance overlays are applied only *after* the agent stops, so bounded external
verification decides the score rather than the model's own account of itself:

```bash
ROCKY_BENCH_TRIALS=3 bun bench/run.ts
```

---

## Qodo code review evidence

Every substantive change reached `main` through a pull request reviewed by
[Qodo](https://qodo.ai). Repository policy is in [`.pr_agent.toml`](.pr_agent.toml),
which instructs the reviewer to treat snapshots, patches, MCP auth, approval
gates, container boundaries, path validation, secret handling, and cancellation
as security-critical.

| PR | Change | Qodo verdict |
|---|---|---|
| [#1](https://github.com/adityasasidhar/rocky-code/pull/1) | `fix: restore benchmark and quality gates` | 6 findings — 4 resolved in-PR, 2 open (see below) |
| [#2](https://github.com/adityasasidhar/rocky-code/pull/2) | `feat: harden TrueForge session recovery` | 6 findings — 5 resolved in-PR (incl. **1 High**), 1 carried into #3 |
| [#3](https://github.com/adityasasidhar/rocky-code/pull/3) | `fix: honor Rocky memory precedence` | ✅ *"Great, no issues found"* |
| [#4](https://github.com/adityasasidhar/rocky-code/pull/4) | agent-instruction corrections | Documentation — describe only |

**Findings that changed the code.** Each maps to a commit:

| Qodo finding | Severity | Fix |
|---|---|---|
| Drops mixed approval actions — an MCP action arriving alongside `tool.approval_required` returned early, stranding the approval and wedging the turn | **High** | [`6c8b489`](https://github.com/adityasasidhar/rocky-code/commit/6c8b489) |
| Trials have no deadline · verifier execution unbounded | **High** | [`2d2a566`](https://github.com/adityasasidhar/rocky-code/commit/2d2a566) |
| Hidden bench overlays remained agent-readable | Medium | [`2d2a566`](https://github.com/adityasasidhar/rocky-code/commit/2d2a566) |
| Deleted tests still scored as passing | Medium | [`2d2a566`](https://github.com/adityasasidhar/rocky-code/commit/2d2a566) |
| `extraSystem` exceeds the 24 KB cap on multi-byte input | Medium | [`eed4faa`](https://github.com/adityasasidhar/rocky-code/commit/eed4faa) |
| Replay pagination can loop | Medium | [`289959c`](https://github.com/adityasasidhar/rocky-code/commit/289959c) |
| Replay buffers unbounded history | Medium | [`d892556`](https://github.com/adityasasidhar/rocky-code/commit/d892556) |
| Oversized memory copied before truncation | Medium | [`43e934f`](https://github.com/adityasasidhar/rocky-code/commit/43e934f) |
| Empty `ROCKY.md` incorrectly fell through to `AGENTS.md` | Medium | [`d845856`](https://github.com/adityasasidhar/rocky-code/commit/d845856) |

The `ROCKY.md` finding is the one worth reading twice: Qodo caught a precedence
bug where an intentionally-empty memory file silently fell back to a different
file, which would have let a user believe they had disabled project memory when
they had not. It became its own PR — and that PR came back clean.

**Findings still open.** Both are confined to `bench/`, the offline benchmark
harness. Neither is reachable from the agent, the broker, or any workspace path:

| Qodo finding | Severity | Status |
|---|---|---|
| Verifier descendants survive cleanup — a descendant that ignores `SIGTERM` and redirects its inherited pipes outlives the SIGKILL escalation cleared in `verify()` | **High** | Fixed in [#5](https://github.com/adityasasidhar/rocky-code/pull/5), with a regression test that fails without it |
| Valid test additions fail | Medium | Open — under review |

---

## Documentation

| | |
|---|---|
| [`docs/WRITEUP.md`](docs/WRITEUP.md) | **Start here** — the submission write-up: the idea, how TrueForge is used, what was hard, and honest status. |
| [`DESIGN.md`](DESIGN.md) | The running engineering log — every decision, the tradeoff behind it, and the bug that motivated it. Includes live-validation transcripts and a "what I'd do differently" section. Read before any structural change. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model and trust boundaries |
| [`docs/GENERATED_TOOLS.md`](docs/GENERATED_TOOLS.md) | Session-only generated-tool contract |
| [`docs/DEMO.md`](docs/DEMO.md) | Three-minute demo outline |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, verification gates, review bar |
| [`AGENTS.md`](AGENTS.md) | Rocky's own agent memory file |

---

## Hackathon disclosure

Built for the [TrueForge Agent Harness Hackathon](https://www.wemakedevs.org/hackathons/trueforge/rules).

Rocky's original local provider loop and terminal UI **existed before** the
hackathon. Hackathon-period work is: the TrueForge backend, SSE normalization and
reconnect, the worker broker and its adapters, sanitized snapshots, hardened
containers, the candidate-patch/checkpoint workflow, bounded recovery primitives,
the generated-tool policy, the orchestration UI, the `doctor` command, and this
security and demo material.

AI coding assistants were used during implementation and review. Every
architectural decision, tradeoff, and rejected alternative is written down in
[`DESIGN.md`](DESIGN.md) in the first person, along with the bugs that forced
each one — because being able to explain the system is the point.

## License

[MIT](LICENSE)

<div align="center"><sub>♫ fist my bump</sub></div>
