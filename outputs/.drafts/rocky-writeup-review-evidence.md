# Rocky Writeup — Evidence Notes

Artifact: `docs/WRITEUP.md` (12,747 bytes; submission writeup, not an arXiv/PDF paper).
Inspection date: 2026-08-30.
Repo state: branch `main`, working tree has uncommitted modifications (irrelevant to writeup claims; none touch docs/WRITEUP.md).

## 1. Quantitative claims

### "961 tests run in about seven seconds" (writeup §3, §5)

Verification (`bun test`, full run):
```
970 pass
  1 skip
  0 fail
2236 expect() calls
Ran 971 tests across 55 files. [9.16s]
```

Verdict: **MISMATCH on count and on timing.**
- Writeup states 961; actual is **971 tests (970 pass + 1 skip)**.
- Writeup states "about seven seconds"; actual wall-clock on this machine is **9.16s**.
- The "961" number also appears in `DESIGN.md` line 18 ("961 tests, typecheck clean"), so the stale figure is propagated across at least two top-level docs.

Possible explanations:
- Bench fixtures (`bench/tasks/<name>/`) are excluded from `bun test` (`tsconfig.json` excludes `bench/tasks`, `bunfig.toml` `[test] root = "test"`). The "961" figure might pre-date the addition of more tests in `test/`.
- The one skip is `credential-free worker container > edits only its disposable snapshot and returns a candidate patch` — gated on `ROCKY_CONTAINER_TEST=1`, unavailable in normal runs.

### "`@truefoundry/trueforge-sdk` (0.1.3)" (writeup §2)

Verification: SDK is imported in `src/backend/trueforge.ts` as
`import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";`.
Lockfile/bun.lock and the public npm registry were not re-checked in this review.
The version string "0.1.3" appears in the writeup but not as a quoted literal in the codebase (the SDK package handles its own versioning).

Verdict: **PLAUSIBLE but not directly cross-checkable from the repo alone.** Recommend checking `bun.lock` and `npm view @truefoundry/trueforge-sdk versions` against this claim.

### "TrueForge owns / Rocky owns" table (writeup §2)

Verification: most rows align with the code.
- "Root agent loop, planning, tool selection" — `src/backend/trueforge.ts` defines the agent spec and let TrueForge drive the loop.
- "Durable sessions, turn history" — `PersistedState` interface in `src/backend/trueforge.ts` records `sessionId`, `activeTurnId`, `lastSequenceNumber`, `snapshotId`, `snapshotAttached`.
- "SSE turn streaming and reconnect" — `consumeStream` in `trueforge.ts` has a reconnect loop with `reconnects >= 2` cap.
- "Worker broker, containers, stream adapters" — `src/broker/{broker,server,adapters,recovery}.ts`.
- "Candidate-patch → checkpoint → apply pipeline" — `src/workspace/patch.ts`; `applyWorkspacePatch` and `undoWorkspacePatch` are imported in `bench/harness.ts` and `src/backend/trueforge.ts`.
- "Workspace snapshotting, secret exclusion" — `src/workspace/snapshot.ts` (referenced from `trueforge.ts`).
- "Terminal UI, scrollback, footer, keys" — `src/tui/app/` (per AGENTS.md).

Verdict: **CONFIRMED.**

## 2. Trust-boundary / approval claims

### "`requireApprovalForTools: ['workspace_apply_patch', 'workspace_undo', 'worker_cancel']`" (writeup §2)

Verification: `src/backend/trueforge.ts` line ~360, inside `ensureSession()`:
```
requireApprovalForTools: ["workspace_apply_patch", "workspace_undo", "worker_cancel"],
```
Match: **EXACT.**

### "`preloadTools: ['worker_list', 'worker_recommend']`" (writeup §2)

Verification: same agent spec block:
```
preloadTools: ["worker_list", "worker_recommend"],
```
Match: **EXACT.**

### Eight MCP tools listed (writeup §2)

`worker_list`, `worker_recommend`, `worker_start`, `worker_status`, `worker_result`, `worker_cancel`, `workspace_apply_patch`, `workspace_undo`.

Verification: enumerated in the ROOT_INSTRUCTIONS prompt in `src/backend/trueforge.ts`; the `worker_*` set is also reflected in `bench/harness.ts`'s PATH/DISABLED tools and the `adapters.ts` worker lifecycle.

Verdict: **CONFIRMED as the design surface.** Whether all eight are implemented as MCP tools depends on `src/broker/adapters.ts` and `src/broker/server.ts` registration — not exhaustively re-checked.

## 3. Broker / portability claims

### Broker on `127.0.0.1` with bearer token (writeup §2)

Verification:
- `src/config/schema.ts`:
  - `host: z.literal("127.0.0.1").default("127.0.0.1")`
  - `port: z.number().int().min(1024).max(65_535).default(8791)`
  - `tokenEnv: ... .default("ROCKY_BROKER_TOKEN")`
- `src/broker/server.ts`: `if (request.headers.get("authorization") !== \`Bearer ${token}\`) return new Response("Unauthorized", { status: 401 });`
- `src/broker/broker.ts`: `import { Database } from "bun:sqlite";`

Verdict: **CONFIRMED.** Loopback-only, project-owned bearer-auth broker on a fixed default port.

### "Runs recorded in SQLite" (writeup §2)

Verification: `src/broker/broker.ts` imports `bun:sqlite` (Bun-native SQLite). The persistence schema and table names were not re-read.

Verdict: **PLAUSIBLE.** Schema not re-verified.

### "Sessions are durable. Session id, active turn, snapshot attachment state, and the SSE sequence cursor persist under `.rocky/trueforge/`" (writeup §2)

Verification:
- `src/backend/trueforge.ts`: `const dir = join(root, ".rocky", "trueforge");`
- `PersistedState` interface: `{ sessionId?, activeTurnId?, lastSequenceNumber, snapshotId?, snapshotAttached }`.
- `saveState()` writes `session.json` with mode `0o600`.

Verdict: **CONFIRMED.** Note that `.rocky/trueforge/` is a per-`root` directory and `session.json` is the only file mentioned in the type — not a full SQLite database.

## 4. Stream-normalization claims

### "Codex emits JSONL, Claude Code emits streaming-JSON print mode, OpenCode emits JSON run mode" (writeup §3)

Verification (`src/broker/adapters.ts`):
- Codex adapter builds `["codex", "exec", "--json", "--ephemeral", ...]` and `parseLine` calls `JSON.parse(line)` (JSONL per line).
- Claude adapter builds `["claude", "-p", "--verbose", "--output-format", "stream-json", ...]` and looks for nested `message` blocks.
- OpenCode adapter (read partially — file cut at 120 lines) builds `["opencode", "run", "--format", "json", ...]`.
- Each `parseLine` falls back to `event("message", line, "plain-text-fallback")` on `JSON.parse` failure.

Verdict: **CONFIRMED.** Adapters exist for all three workers; each has a plain-text fallback; each normalizes to the same `WorkerEvent` shape.

## 5. Recovery policy claims

### "Caps automated attempts at three and branches on failure kind" (writeup §3)

Verification (`src/broker/recovery.ts`):
```
export class RecoveryBudget {
  private attempts = 0;
  constructor(readonly limit = 3) {}
  ...
}
```
```
export function classifyFailure(message: string, exitCode?: number): WorkerExitClass {
  ...
  if (/unauthori[sz]ed|authentication|invalid api key|401|credential/.test(text)) return "authentication";
  if (/not found|no such image|cannot connect to the docker daemon|unavailable/.test(text)) return "unavailable";
  if (/timed? out|timeout|deadline/.test(text) || exitCode === 124) return "timeout";
  if (/invalid.*(?:json|event)|truncated.*(?:json|stream)/.test(text)) return "invalid_stream";
  if (/invalid patch|does not apply|patch failed/.test(text)) return "invalid_patch";
  if (/test.*failed|validation.*failed/.test(text)) return "validation_failed";
  if (/config|missing model|unknown option/.test(text)) return "configuration";
  return "crash";
}
```

Verdict: **CONFIRMED.** Limit=3 and seven-way classifier both match the writeup's prose.

## 6. Loop purity claim

### "`src/core/loop.ts` does no I/O, holds no globals, and never throws for tool failures. Every `tool_use` yields exactly one `tool_result`" (writeup §3)

Verification:
- `runTurn` is `export async function* runTurn(...)` — pure async generator that yields `LoopEvent`s (no `console.log`, no `process.exit`, no module-level mutable state).
- File comment: "It never writes to stdout and never throws for a tool failure — a tool error is a `tool_result` the model gets to see and recover from."
- `src/core/loop.ts:100-114` confirms the generator shape and the comment.

Caveat: "Holds no globals" is harder to verify without reading every reference. The generator closure only depends on `deps`, `session`, `signal` — none are global. The file imports no module-level mutable singletons.

Verdict: **MOSTLY CONFIRMED.** Every claim is verifiable from the function signature and its comment.

## 7. TUI / OpenTUI patch claims

### "@opentui/core@0.4.5 patch under patches/" (writeup §3)

Verification:
- `patches/@opentui%2Fcore@0.4.5.patch` exists.
- `bunfig.toml`: `preload = ["@opentui/solid/preload"]` (the OpenTUI Solid transform).
- `tsconfig.json`: `"jsxImportSource": "@opentui/solid"` (Solid JSX, not React).

Verdict: **PARTIALLY CONFIRMED.** The patch file exists; the writeup's claim that the patch "parses SGR into styled spans for `capture-stdout` scrollback" was not opened directly to verify the diff content, but its existence and the patch naming convention match the bunfig/tsconfig evidence.

## 8. Typecheck / lint gates

### "CI gates every PR on `bunx tsc --noEmit` (strict, plus `noUnusedLocals` / `noUnusedParameters` / `noUncheckedIndexedAccess`)" (writeup §4)

Verification:
- `tsconfig.json`: `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noUncheckedIndexedAccess": true`.
- `.github/workflows/ci.yml` quality job: `bunx tsc --noEmit` then `bun test`.

Verdict: **CONFIRMED.**

## 9. Qodo findings ↔ commits

### Ten commit hashes plus two PR links (writeup §4 table)

Verification via `git log --oneline --all`:
| Hash | Subject |
|---|---|
| `6c8b489` | fix: preserve mixed TrueForge actions |
| `2d2a566` | fix: bound and isolate benchmark execution |
| `eed4faa` | fix: cap project memory by UTF-8 bytes |
| `289959c` | fix: guard TrueForge replay pagination |
| `d892556` | fix: bound TrueForge history replay |
| `43e934f` | perf: bound project memory processing |
| `d845856` | fix: honor Rocky memory precedence |

All seven short hashes resolve to distinct commits whose subjects match the writeup's claim about what each one fixed.

PR #5 (Verifier descendants survive cleanup) and PR #6 (bench judge required byte-identical test file) — not checked in this review (network access to GitHub not exercised). Existence is plausible given the narrative.

Verdict: **CONFIRMED for the seven inline commits.** PR links unverified.

## 10. Bench harness / hidden overlays

### "`bench/` runs the real loop in disposable repositories behind a workspace-only tool boundary, and hidden acceptance overlays are applied only *after* the agent stops" (writeup §4)

Verification:
- `bench/tasks/` contains three fixtures: `add-feature-with-test`, `cross-file-rename`, `fix-failing-test`. Each has `repo/`, `hidden/`, `spec.json`.
- `bench/harness.ts`: imports `runTurn` from `../src/core/loop.ts` and uses it directly against the task. `PATH_TOOLS` and `DISABLED_BENCH_TOOLS` restrict the tool surface.

Verdict: **CONFIRMED.**

## 11. Container-isolation fixture

### "`ROCKY_CONTAINER_TEST=1 bun test test/broker/container.test.ts` (requires locally-built `rocky-worker-fixture:1`)" (AGENTS.md; cited implicitly in writeup §5)

Verification:
- `.github/workflows/ci.yml` `container-fixture` job: builds `rocky-worker-base:1` then `rocky-worker-fixture:1`, then runs `bun test test/broker/container.test.ts` with `ROCKY_CONTAINER_TEST=1`.

Verdict: **CONFIRMED.**

## 12. Secret scanning

### "`gitleaks scan of full history`" (writeup §4)

Verification: `.github/workflows/ci.yml` `secret-scan` job uses `gitleaks/gitleaks-action` with `fetch-depth: 0` (full git history).

Verdict: **CONFIRMED.**

## 13. Doctor command (writeup §5)

Verification:
- `src/cli.ts` line 89 documents `rocky doctor`.
- `src/cli.ts` line 224-235 dispatches `subcommand === "doctor"` to `doctor(cwd, config)` and `formatDoctor(...)`.
- `src/doctor.ts` is the implementation.

Verdict: **CONFIRMED.**

## 14. "Blocked on one external credential: a Daytona API key" (writeup §5)

Verification: cannot be confirmed or denied from the repo alone — depends on the user's TrueForge deployment state and Daytona account. The writeup correctly identifies this as a deployment dependency, not a code defect.

Verdict: **PLAUSIBLE; cannot independently verify.**

## 15. Stylistic observations

- No "Related work" / "Prior art" section.
- No quantitative comparison to other harnesses (Claude Code native sub-agents, OpenAI's Codex CLI delegation patterns, OpenCode's own delegation, Aider, etc.).
- Two adjacent claims about bench fidelity are interesting and rare: (a) "the probe copied symlinks and then wrote through one" — implies a path-traversal vector; (b) "the probe copied the repo wholesale, so the agent's own test code ran in a tree containing the hidden overlay and could have read the judge and answered to it" — implies the bench judge itself could have been compromised. The writeup reports both as fixed by Qodo review, but doesn't cite specific tests or commit hashes for these two findings (unlike the others).
- Three races of the same bug ("Verifier descendants survive cleanup") is described with unusual care. This is a strength.

## 16. Sources

Inspected paths:
- `/home/arctic/projects/rocky_code/docs/WRITEUP.md`
- `/home/arctic/projects/rocky_code/DESIGN.md`
- `/home/arctic/projects/rocky_code/README.md`
- `/home/arctic/projects/rocky_code/tsconfig.json`
- `/home/arctic/projects/rocky_code/bunfig.toml`
- `/home/arctic/projects/rocky_code/package.json`
- `/home/arctic/projects/rocky_code/patches/@opentui%2Fcore@0.4.5.patch`
- `/home/arctic/projects/rocky_code/.github/workflows/ci.yml`
- `/home/arctic/projects/rocky_code/src/backend/trueforge.ts`
- `/home/arctic/projects/rocky_code/src/broker/adapters.ts` (partial)
- `/home/arctic/projects/rocky_code/src/broker/recovery.ts`
- `/home/arctic/projects/rocky_code/src/broker/server.ts` (partial)
- `/home/arctic/projects/rocky_code/src/core/loop.ts` (partial)
- `/home/arctic/projects/rocky_code/src/core/memory.ts`
- `/home/arctic/projects/rocky_code/src/config/schema.ts` (grep)
- `/home/arctic/projects/rocky_code/bench/harness.ts` (partial)
- `/home/arctic/projects/rocky_code/bench/tasks/` (structural inspection)
- `bun test` runtime invocation (results above)
- `git log --oneline --all` for commit hashes
