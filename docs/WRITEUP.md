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
is what makes the loop testable without a live model, and it is why 961 tests run
in about seven seconds.

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
| Valid test additions fail — the bench judge required a byte-identical test file | Medium | [#6](https://github.com/adityasasidhar/rocky-code/pull/6) |

Three are worth reading twice. **"Empty `ROCKY.md` falls back"** was a precedence bug
where an intentionally-empty memory file silently deferred to a different file —
a user would believe they had disabled project memory when they had not. It became
its own PR, and that PR came back clean. **"Verifier descendants survive cleanup"**
was subtler, and the review of the *fix* is the better artifact. The bench
verifier awaited the process-group leader and its two pipes, then cancelled the
pending SIGKILL — but a descendant that ignores SIGTERM and releases its
inherited pipes satisfies all three conditions while still running, so it escaped
the trial and the temporary repository teardown. Qodo then found three issues in
the first fix, the sharpest being that the replacement sweep could fire *before*
the two-second SIGTERM grace elapsed, killing a descendant that was shutting down
cleanly. The landed version probes the group with `signal 0` first — nothing
survived costs one syscall and no delay; only a real survivor waits out the
remaining grace — and the regression test fails without it. Re-review clean.

The last finding to close was the one where Qodo judged the judge. The bench's
own acceptance check demanded the visible test file come back byte-for-byte
identical, so an agent that fixed the bug *and added a test* scored as failing —
the benchmark was partly measuring compliance with a rule the task never stated.
The first fix just read the file more cleverly, and Qodo put three holes in it;
the one that mattered was that `if (false) expect(add(2, 3)).toBe(5)` is
textually indistinguishable from a live assertion. No parser settles that —
whether an assertion still enforces anything is a question about execution.

So the check stopped reading and started running. It swaps in an implementation
correct for every input except the one the shipped test pins, and requires the
visible suite to notice: the contract holds when the suite passes against a
correct `add`, reaches the same verdict whether or not the runner thinks it is on
CI, and fails against the mutant. All three are load-bearing — the first alone
accepts a test that asserts nothing, the third alone accepts an assertion
rewritten to expect the wrong answer, and the second rules out a suite whose
result depends on where it runs.

Qodo then reviewed that fix, and the one after it — four rounds and twelve more
findings. Two were the kind worth catching: the probe copied symlinks and then
wrote through one, so a repository whose `src/math.ts` was a link could have
redirected the write into the workspace the check exists to protect; and the
probe copied the repo wholesale, so the agent's own test code ran in a tree
containing the hidden overlay and could have read the judge and answered to it.
The first is the same class of bug the threat model already takes seriously about
the agent's file tools; the second defeats the premise the benchmark rests on.
Both were in the judge, not the agent.

That is the project's thesis applied one level down: a claim about a test is not
evidence about a test, and the thing doing the judging gets audited on the same
terms as the thing being judged. No findings remain open.

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
  pipeline, and the bench harness. 961 tests passing, typecheck clean. `DESIGN.md` records
  live-validation transcripts against real models for the local backend, including
  the bugs those runs found.
- **Verified live against a running TrueForge:** against `npx
  @truefoundry/trueforge@latest` on `:8790`, `doctor` reports the harness
  healthy, the root model FQN resolves from the server's own configured-model
  list, the broker registers over MCP and comes back `authenticated`, sessions
  create against an inline agent spec, and turns stream back over SSE.
- **Blocked on one external credential:** a Daytona API key, configured in
  TrueForge under *Settings → Sandbox providers*. Rocky attaches the workspace
  snapshot as a file on the first turn of a session, and TrueForge materializes
  attachments in the sandbox — so with no sandbox provider that turn fails
  rather than degrading. That is a genuine dependency, not a workaround gap: the
  sandbox is what the design puts between a worker's claim and the checkout.
  `doctor` names it as a failing required check rather than reporting the agent
  spec's own `sandbox: true` back at you, which is what it used to do.
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
