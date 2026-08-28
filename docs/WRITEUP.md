# Rocky — TrueForge Agent Harness Hackathon submission

**Repository:** https://github.com/adityasasidhar/rocky-code
**Track focus:** Best Use of TrueForge · Best Code Quality · Best UI

---

## 1. The idea in one paragraph

Every coding agent ends its turn by writing to your working tree and telling you
it worked. The model that wrote the patch is also the only witness to whether the
patch is good — and it is the least reliable witness available, because *"I fixed
it"* is the cheapest token sequence in the distribution. Stacking a second agent
on top makes it worse: now two models agree with each other over a checkout
neither is accountable for. **Rocky separates who writes the patch from who is
allowed to believe it.** A TrueForge root agent plans and delegates; disposable
Codex / Claude Code / OpenCode workers in pinned containers produce *candidate
patches*; Daytona independently validates them; TrueForge halts for human
approval; and only then does a checkpointed, reversible apply touch real files.

The boundary is the product. Everything else is in service of it.

## 2. What TrueForge actually does here

TrueForge is not a model call behind a wrapper. Rocky hands it the root agent loop
and keeps only what a terminal must own.

| TrueForge owns | Rocky owns |
|---|---|
| Root agent loop, planning, tool selection | Terminal UI, scrollback, footer, keys |
| Durable sessions, turn history | Workspace snapshotting, secret exclusion |
| SSE turn streaming and reconnect | Worker broker, containers, stream adapters |
| Dynamic subagents | Candidate-patch → checkpoint → apply pipeline |
| Daytona sandbox provisioning and validation | Bounded recovery and failure classification |
| Human approval gates on destructive tools | Mapping SDK events into one renderer |

Through the official `@truefoundry/trueforge-sdk` (0.1.3):

- **The approval boundary is configuration TrueForge enforces**, not a prompt Rocky
  hopes a model respects. The agent spec declares
  `requireApprovalForTools: ["workspace_apply_patch", "workspace_undo", "worker_cancel"]`
  and `preloadTools: ["worker_list", "worker_recommend"]` (`src/backend/trueforge.ts`).
- **Sessions are durable.** Session id, active turn, snapshot attachment state, and
  the SSE sequence cursor persist under `.rocky/trueforge/`. Kill Rocky mid-turn,
  restart, `/sessions`, and the turn replays from the cursor via `subscribeToTurn`.
- **Workers reach TrueForge only through MCP.** The broker is registered as an MCP
  connector through the SDK, so TrueForge's own tool-calling machinery drives
  delegation. There is no side channel.
- **Escape cancels the server session**, not just the local render.
- **Every SDK event normalizes into one `LoopEvent` stream**, which is why the
  `local` backend and the TrueForge backend share a renderer and the UI never
  learns which is running.

The broker exposes eight MCP tools — `worker_list`, `worker_recommend`,
`worker_start`, `worker_status`, `worker_result`, `worker_cancel`,
`workspace_apply_patch`, `workspace_undo` — bearer-authenticated on `127.0.0.1`,
runs recorded in SQLite.

## 3. The parts that were actually hard

**Normalizing three hostile stream formats.** Codex emits JSONL, Claude Code emits
streaming-JSON print mode, OpenCode emits JSON run mode — and all three
occasionally emit something else entirely. `src/broker/adapters.ts` normalizes
each into one event shape; a malformed stream degrades to plain-text rather than
crashing the turn, and is *counted* as an adapter-health regression so the failure
is visible instead of silently absorbed.

**Making recovery bounded and classified rather than a retry loop.**
`src/broker/recovery.ts` caps automated attempts at three and branches on failure
*kind*: auth/config errors stop immediately with setup guidance (retrying a
missing API key is theatre), timeouts get one reduced retry then a worker switch,
malformed streams fall back to text, and a failed Daytona check earns one repair
attempt with the failing output attached as evidence.

**Keeping the loop pure.** `src/core/loop.ts` does no I/O, holds no globals, and
never throws for tool failures. Every `tool_use` yields exactly one `tool_result`;
handler throws are caught and converted to `is_error: true`. Errors are data. This
is what makes the loop testable without a live model, and it is why 775 tests run
in about four seconds.

**Not giving Rocky's own source an exemption.** When Rocky patches Rocky, the
patch crosses the same sandbox, the same approval, and the same checkpoint — and
then requires a restart. Rocky never hot-loads code it wrote.

**A TUI that keeps real scrollback.** `src/tui/app/` is a Solid + OpenTUI
split-footer: the footer owns editor, status, spinner, and dialogs while
scrollback stays genuine terminal output you can select and pipe. That required
patching `@opentui/core@0.4.5` to parse SGR into styled spans under
`capture-stdout`. Streaming markdown renders character by character, and the
syntax highlighter is a real lexer rather than a pile of regexes.

## 4. Code quality and Qodo

Every substantive change reached `main` through a pull request reviewed by Qodo.
Repository policy lives in `.pr_agent.toml`, which instructs the reviewer to treat
snapshots, patches, MCP auth, approval gates, container boundaries, path
validation, secret handling, and cancellation as security-critical.

Qodo findings that changed the code — each maps to a commit:

| Finding | Severity | Fix |
|---|---|---|
| Drops mixed approval actions (approval stranded, turn wedged) | High | `6c8b489` |
| Trials have no deadline · verifier execution unbounded | High | `2d2a566` |
| Verifier descendants survive cleanup | High | [#5](https://github.com/adityasasidhar/rocky-code/pull/5) |
| Hidden bench overlays remained agent-readable | Medium | `2d2a566` |
| Deleted tests still scored as passing | Medium | `2d2a566` |
| `extraSystem` exceeds the 24 KB cap on multi-byte input | Medium | `eed4faa` |
| Replay pagination can loop | Medium | `289959c` |
| Replay buffers unbounded history | Medium | `d892556` |
| Oversized memory copied before truncation | Medium | `43e934f` |
| Empty `ROCKY.md` fell through to `AGENTS.md` | Medium | `d845856` |

Two are worth reading twice. **"Empty `ROCKY.md` falls back"** was a precedence bug
where an intentionally-empty memory file silently deferred to a different file —
a user would believe they had disabled project memory when they had not. It became
its own PR, and that PR came back clean. **"Verifier descendants survive cleanup"**
was subtler: the bench verifier awaited the process-group leader and its two
pipes, then cancelled the pending SIGKILL — but a descendant that ignores SIGTERM
and redirects its inherited pipes satisfies all three conditions while still
running, so it escaped the trial. The fix sweeps the group in the same `finally`,
and the regression test fails without it.

Beyond review, CI gates every PR on `bunx tsc --noEmit` (strict, plus
`noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess`), the full
`bun test` suite, a container-isolation fixture, and a gitleaks scan of full
history.

Evaluation does not trust the model either: `bench/` runs the real loop in
disposable repositories behind a workspace-only tool boundary, and hidden
acceptance overlays are applied only *after* the agent stops, so bounded external
verification decides the score rather than the agent's account of itself.

## 5. Honest status

- **Complete and verified:** the agent loop, tools, permissions, context
  management, TUI, providers, broker, adapters, recovery policy, snapshot/patch
  pipeline, and the bench harness. 775 tests, typecheck clean. `DESIGN.md` records
  live-validation transcripts against real models for the local backend, including
  the bugs those runs found.
- **Complete, pending live validation:** the TrueForge orchestration path is
  implemented and unit-tested end to end (SDK event mapping, approvals, resume
  cursors, MCP auth). Validation against a running TrueForge + Daytona
  deployment is in progress and is what the demo recording captures; the local
  backend is the path with published live transcripts today.
- **Pre-existing work:** Rocky's original local provider loop and terminal UI
  predate the hackathon. Hackathon-period work is the TrueForge backend, SSE
  normalization and reconnect, the worker broker and adapters, sanitized
  snapshots, hardened containers, the candidate-patch/checkpoint workflow,
  bounded recovery, the generated-tool policy, the orchestration UI, `doctor`,
  and the security/demo material.

AI coding assistants were used during implementation and review. Every
architectural decision, tradeoff, and rejected alternative is written down in
`DESIGN.md` in the first person, along with the bug that forced it — because
being able to explain the system is the point.

## 6. Where to look

| | |
|---|---|
| `README.md` | Setup, quickstart, architecture, safety model |
| `DESIGN.md` | The full engineering log — decisions, tradeoffs, bug history |
| `docs/SECURITY.md` | Threat model and trust boundaries |
| `docs/GENERATED_TOOLS.md` | Session-only generated-tool contract |
| `src/backend/trueforge.ts` | The TrueForge integration |
| `src/broker/` | MCP broker, worker adapters, recovery policy |
| `src/workspace/patch.ts` | Candidate patch → checkpoint → apply → undo |
