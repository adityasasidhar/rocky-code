# Rocky Writeup — Review

Artifact: `docs/WRITEUP.md` (12,747 bytes).
Source type: hackathon submission writeup (Markdown, not arXiv/PDF).
Date inspected: 2026-08-30.
Reviewer scope: lead-owned (single primary reviewer; subagent delegation not warranted for a 12 KB writeup).

---

## Summary Assessment

Rocky's writeup is a strong engineering-narrative artifact. Most factual claims about the system are verifiable from the repo and were cross-checked during this review. The architectural thesis — separating the writer of a patch from the verifier of the patch, with the verifier being an independent sandbox rather than a second LLM — is clearly stated and borne out by the code layout.

The writeup is not a research paper and should not be graded on novelty / empirical rigor criteria calibrated for one. It is engineering communication aimed at a hackathon judging panel. Within that frame, it is unusually rigorous: it cites specific commit hashes, names its dependencies, admits the gaps in its bench harness, and discloses an external credential blocker in the open.

Two specific factual claims are stale: the test count ("961") and the test runtime ("about seven seconds") no longer match the current `bun test` output (971 tests / 9.16s). These propagate into `DESIGN.md` and should be updated before this writeup is shown to a panel. There is also no "Related work" / "Prior art" section, which is acceptable for a submission but limits the artifact's reuse as a reference.

Recommendation: **acceptable with minor revisions.** Fix the stale numbers; tighten the two unbacked-by-commit-hash claims about the bench judge. The rest of the file stands.

---

## Strengths

- **Highly specific, testable claims.** Every numbered architectural claim — agent spec, eight MCP tools, three-attempt recovery cap, SQLite-backed broker — has a one-line cross-check in `src/`. This is rare for a submission writeup.
- **Honest gap disclosure.** The "Honest status" section names the Daytona API key as a real blocker and does not paper over it. `doctor` is also named as "what it used to do" before being fixed, which is honest framing of past weakness.
- **Commit-hash auditability.** Seven of the Qodo findings map to exact short hashes; this means a panel can `git show` each one rather than trust the prose. The same is true for the recovery-policy code, the agent spec, and the broker defaults.
- **Self-criticism of the bench judge.** Three paragraphs (writeup §4 second half) describe how a static text check fooled itself, then how the dynamic check that replaced it still had symlink and overlay-leak bugs. This kind of reflexive audit is rare in any artifact and unusually so in a submission.
- **Clear ownership table.** The "TrueForge owns / Rocky owns" table preserves the architectural argument in a single diagram. This is the load-bearing piece of the writeup and it is well built.
- **Probe + grace + sweep pattern for process cleanup.** The "Verifier descendants survive cleanup" fix — `signal 0` probe, then grace, then sweep — is a thoughtful engineering pattern, not the usual retry-loop answer.

## Critical Issues

None.

## Major Issues

### M1. Test count is stale in two top-level documents

**Claim:** "961 tests run in about seven seconds" (`docs/WRITEUP.md` §3 and §5).
**Observed:** `bun test` reports 971 tests (970 pass, 1 skip) across 55 files in 9.16 seconds on this machine.
**Where it lives:**
- `docs/WRITEUP.md:78` — "961 tests run in about seven seconds"
- `docs/WRITEUP.md:176` — "961 tests passing, typecheck clean"
- `DESIGN.md:18` — "961 tests, typecheck clean"

**Why it matters:** Test count and runtime are the kind of headline numbers a judge will spot-check. A 10-test and 2-second delta is small but the *consistency* of the figure across two top-level documents makes it look intentional. Either bump both numbers to "971 tests in ~9 seconds" (and clarify that 1 is the gated container-fixture skip) or document why `bun test` is not the source of truth (e.g., the writeup is about the bench harness, not the unit tests).

### M2. Two bench-judge findings in §4 lack commit hashes

The first six Qodo findings in §4 each cite a short commit hash. The two findings introduced at the bottom of the paragraph —

> "the probe copied symlinks and then wrote through one, so a repository whose `src/math.ts` was a link could have redirected the write into the workspace the check exists to protect"

> "the probe copied the repo wholesale, so the agent's own test code ran in a tree containing the hidden overlay and could have read the judge and answered to it"

— are described as the sharpest findings but neither cites a hash or PR. Given that the rest of the table is anchored by hash, the omission makes those two claims harder for a reviewer to audit. Either add the hash or note explicitly that they were caught by Qodo but rolled into a single later fix.

### M3. No "Related work" / "Prior art" section

The writeup implicitly frames Rocky against Codex CLI, Claude Code, OpenCode, and Daytona, but never cites published harness designs or prior agent-orchestration literature. For a submission this is fine; if the writeup is repurposed as documentation or as a paper draft, the absence will read as either ignorance of the field or as strategic omission. A short paragraph distinguishing Rocky from Anthropic's sub-agents and OpenAI's Codex delegation patterns would close the gap cheaply.

## Minor Issues

### m1. "961 tests" elsewhere

In addition to WRITEUP and DESIGN, the count is repeated in the conversation history of this session's git log (e.g., `a98f2d0` "updated the gif and the CONTRIBUTOR.md") — out of scope to fix here, but the figure should be regenerated from a single source (CI badge, or a script that runs `bun test` and writes the count to a JSON file).

### m2. `@truefoundry/trueforge-sdk` version 0.1.3 not independently verifiable

The writeup cites SDK version 0.1.3 in §2 ("Through the official `@truefoundry/trueforge-sdk` (0.1.3)"). The version string is not in `bun.lock` directly visible to this review. Recommend adding a one-liner showing `bun pm ls @truefoundry/trueforge-sdk` output or pinning the version in `package.json` if not already pinned.

### m3. "Escape cancels the server session" not verified in §2

§2 claims "Escape cancels the server session, not just the local render." This is plausible (the SDK has a `cancel` method on sessions — see `client.sessions.cancel(this.state.sessionId)` in `src/backend/trueforge.ts:572`), but the binding between the user's Esc keypress and that SDK call lives in `src/tui/keys.ts` / `src/tui/app/`, which was not opened. Acceptable for a writeup; flag for completeness.

### m4. "Snapshot is sanitized"

§2 says "Workers edit disposable copies of this; they cannot reach the real checkout, the Docker socket, or secrets." The exact sanitization rules (path exclusions, secret patterns, max bytes) live in `src/workspace/snapshot.ts` and `src/config/schema.ts` (`secretPatterns`, `maxSnapshotBytes`). Cite these defaults or add a sentence noting where they are configured.

### m5. The `awaitThisTurn` semantics

§3 mentions "961 tests run in about seven seconds" without explaining the skip. The single skip (`credential-free worker container`) is exactly the kind of detail a panel will probe. Mention it.

### m6. Bench judge fix narrative could stand a date or commit

§4's last three paragraphs tell a multi-round story of bench-judge fixes ("four rounds and twelve more findings"). Without a single anchoring commit or PR, the reader has to take the narrative on faith. The narrative is credible — it has the texture of real debugging — but the absence of any anchor is jarring against the rest of the section, which is anchor-rich.

## Reproducibility and Verification

| Check | Status | Notes |
|---|---|---|
| Can a fresh clone reproduce the test count? | **PARTIAL.** Test count is 971, not 961. | Update docs. |
| Can a fresh clone reproduce `bunx tsc --noEmit` clean? | **CONFIRMED.** tsconfig.json flags are pinned; CI runs the same command. | |
| Can a fresh clone reproduce `bun test` cleanly? | **CONFIRMED.** CI runs the same command. | |
| Can a fresh clone reproduce the container-fixture test? | **CONDITIONAL.** Requires `docker build` for `rocky-worker-fixture:1` (CI builds it; the README hints at this). | Confirm the build args are pinned (CI uses `--build-arg ROCKY_WORKER_BASE=rocky-worker-base:1`). |
| Can a fresh clone reproduce `doctor` against a real TrueForge? | **PARTIAL.** Requires TrueForge to be running on `:8790` and the user to set `TRUEFORGE_TOKEN`. | The writeup correctly notes this; not a code defect. |
| Can a fresh clone reproduce the bench results cited in §4? | **NOT VERIFIED.** Bench harnesses are present and structurally correct, but no recorded results are included. | |
| Are the Qodo commit hashes reachable from `main`? | **CONFIRMED** for seven hashes. PR #5 / #6 not checked. | |
| Is gitleaks configured? | **CONFIRMED** in `.github/workflows/ci.yml`. | |
| Are provider API keys stored securely? | **OUT OF SCOPE.** `src/config/credentials.ts` referenced from AGENTS.md but not opened here. | |

## Inline Annotations

### WRITEUP §2, paragraph "Workers reach TrueForge only through MCP"

> "The broker is registered as an MCP connector through the SDK, so TrueForge's own tool-calling machinery drives delegation. There is no side channel."

**Annotation:** Verified against `src/backend/trueforge.ts` `ensureBrokerRegistered()`, which calls `this.client.settings.mcpServers.createOrUpdate({ manifest: { ... type: "remote", url: this.brokerEndpoint.url, auth: { type: "header", headers: { Authorization: \`Bearer ${...}\` } } } })`. The word "side channel" is loaded — the SDK is the broker registration surface, but the broker itself is project-owned on `127.0.0.1:8791`, so TrueForge's `mcpServers` config is the only "channel" the root agent sees. Faithful to the implementation.

### WRITEUP §3, "Keeping the loop pure"

> "Every `tool_use` yields exactly one `tool_result`; handler throws are caught and converted to `is_error: true`. Errors are data."

**Annotation:** Verified in `src/core/loop.ts` comment and in the `LoopEvent` union — `tool_end` carries a `ToolResult` and the generator never throws for tool failures. Strictly speaking the SDK message-stream may yield *multiple* `tool_use` blocks per assistant turn, each of which becomes one `tool_result`; the phrasing is correct as written.

### WRITEUP §3, "Not giving Rocky's own source an exemption"

**Annotation:** Plausible from the architecture — the worker tools write to a snapshot, the apply-patch tool is gated, and the agent does not have an `edit_file` tool in TrueForge mode (per ROOT_INSTRUCTIONS: "You never edit files directly. ... If you find yourself wanting to run `edit_file`, you are in the wrong mode."). Not independently re-verified in this review.

### WRITEUP §4, Qodo findings table

**Annotation:** All seven inline hashes resolve to distinct commits whose messages match the row claims. The two PR links (#5, #6) were not opened. The table is the single most verifiable part of the writeup.

### WRITEUP §4, "the probe copied symlinks and then wrote through one"

**Annotation:** See Major Issue M2. Plausible (the probe is implemented in `bench/harness.ts` and uses `cpSync`, which by default follows symlinks), but no commit hash is cited. The hazard is real and worth fixing.

### WRITEUP §5, "Verified live against a running TrueForge: against `npx @truefoundry/trueforge@latest` on `:8790`"

**Annotation:** The exact command (`npx @truefoundry/trueforge@latest`) is a runtime-fetched package and should not be relied on for reproducibility — `@latest` resolves to whatever is current at install time. If `doctor` actually exercises this end-to-end, the writeup should pin the SDK version used at validation time. The version number (0.1.3) cited elsewhere does match this expectation but the `npx @latest` phrasing undercuts it.

## Recommendation

**Acceptable with minor revisions.**

- Fix M1: replace "961 tests run in about seven seconds" with the current number in WRITEUP and DESIGN.
- Fix M2: add commit hashes for the two bench-judge findings, or note that they were rolled into a single fix.
- Address m6: anchor the bench-judge narrative to a date or commit.

The architectural claims, the loop purity argument, the recovery classification, the agent-spec configuration, the broker defaults, and the Qodo audit trail are all corroborated by the codebase. The writeup is fit for the stated purpose (hackathon submission panel) and, with the above three fixes, would also be reusable as a project top-level README blurb or design-rationale record.

## Sources

- `docs/WRITEUP.md` (artifact under review, 12,747 bytes)
- `docs/SECURITY.md`, `docs/GENERATED_TOOLS.md`, `docs/DEMO.md` (companion docs, not re-opened in this review)
- `DESIGN.md` (53,018 bytes; cross-check for the "961 tests" figure and architectural claims)
- `README.md` (top-level; not the primary review target)
- `tsconfig.json` (strict, noUnusedLocals/Parameters/IndexedAccess — confirmed)
- `bunfig.toml` (Solid preload, test root — confirmed)
- `.github/workflows/ci.yml` (typecheck, test, container-fixture, secret-scan — confirmed)
- `src/backend/trueforge.ts` (agent spec, state path, SDK usage — confirmed)
- `src/broker/adapters.ts` (three adapters, plain-text fallback — confirmed)
- `src/broker/recovery.ts` (limit=3, 7-way classifier — confirmed)
- `src/broker/server.ts` (Bearer auth on 127.0.0.1, MCP dispatch — confirmed)
- `src/broker/broker.ts` (`bun:sqlite` import — confirmed)
- `src/config/schema.ts` (broker defaults: host 127.0.0.1, port 8791, tokenEnv ROCKY_BROKER_TOKEN — confirmed)
- `src/core/loop.ts` (pure async generator, no top-level I/O — confirmed)
- `src/core/memory.ts` (ROCKY.md > AGENTS.md, 24 KB cap — confirmed)
- `bench/harness.ts` (real loop, hidden overlay, trial/verify timeouts — confirmed structurally)
- `bench/tasks/{add-feature-with-test,cross-file-rename,fix-failing-test}/hidden/` (hidden overlays present — confirmed)
- `patches/@opentui%2Fcore@0.4.5.patch` (patch file present — confirmed)
- `bun test` runtime (970 pass / 1 skip / 0 fail / 9.16s on this machine)
- `git log --oneline --all` for the seven Qodo-finding commit hashes

Not opened in this review (limit on scope):
- `src/tui/app/` (Solid + OpenTUI split-footer)
- `src/workspace/patch.ts` (candidate patch → checkpoint → apply)
- `src/workspace/snapshot.ts` (sanitization rules)
- `src/config/credentials.ts` (mode 0600 credentials store)
- `docs/SECURITY.md` (threat model)
- PR #5, PR #6 (GitHub links, not network-fetched)
