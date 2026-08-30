# Rocky Writeup — Review Plan

**Slug:** rocky-writeup
**Artifact identifier:** `docs/WRITEUP.md` (12,747 bytes, Markdown)
**Source type:** Local Markdown submission writeup (not arXiv, not PDF)
**Companion artifacts inspected:**
- `README.md`, `DESIGN.md` (53,018 bytes — referenced for cross-check)
- `docs/SECURITY.md`, `docs/GENERATED_TOOLS.md`, `docs/DEMO.md`
- `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`
- `.pr_agent.toml` (Qodo reviewer policy)
- Source tree under `src/` (specifically `src/backend/trueforge.ts`, `src/broker/`, `src/core/loop.ts`, `src/workspace/`, `src/tui/app/`)
- Test tree under `test/`
- `bench/` harness
- `bunfig.toml`, `tsconfig.json`, `package.json`
- `.git/` history (commit hashes, PR refs)
- `bun.lock` (for pinned `@opentui/core@0.4.5`)

## Review criteria (per workflow spec)

1. **Novelty** — Is the architectural claim ("who writes the patch vs who is allowed to believe it", three-stream normalization, bounded/classified recovery, pure loop, sandboxed bench judge) genuinely novel or well-known in the agent-harness literature?
2. **Empirical rigor** — Are the 961-test figure, the live TrueForge verification claim, and the bench judge claim reproducible from the repo alone?
3. **Baselines** — Are competing harness designs (Claude Code native, Codex CLI, OpenCode) cited and contrasted on equal terms, or implicitly strawmanned?
4. **Reproducibility** — Can a third party rerun the bench, the doctor check, and the listed Qodo fixes from a fresh clone?
5. **Claims validity** — Each numbered factual claim in the writeup must be cross-checked against source files and commit history.
6. **Figures/tables** — One comparison table (TrueForge owns / Rocky owns) and one Qodo-findings table — both qualitative, no quantitative figures to verify.
7. **Metrics** — "961 tests in ~7 seconds" is the only quantitative metric. Verify it.
8. **Related work** — None cited explicitly. Note absence as a writing-quality issue.
9. **Writing quality** — Hacker-news style; clear; uses first-person plural; calls out its own gaps ("Honest status", "Blocked on one external credential"). Note this as a strength.

## Verification checks needed

| # | Claim from writeup | Where to verify | What proves it |
|---|---|---|---|
| 1 | `961 tests passing` | `bun test` | Test runner output line |
| 2 | `~7 second` test runtime | `bun test` timing | Wall-clock from same invocation |
| 3 | `src/backend/trueforge.ts` declares `requireApprovalForTools: ["workspace_apply_patch", "workspace_undo", "worker_cancel"]` | Read file | Exact string match |
| 4 | `preloadTools: ["worker_list", "worker_recommend"]` | Read file | Exact string match |
| 5 | `.rocky/trueforge/` stores session/cursor state | `src/broker/` and `src/backend/` | Path usage |
| 6 | Eight MCP tools (`worker_list`, `worker_recommend`, `worker_start`, `worker_status`, `worker_result`, `worker_cancel`, `workspace_apply_patch`, `workspace_undo`) | `src/broker/adapters.ts` or registry | Tool list source |
| 7 | `127.0.0.1` bearer-auth broker | `src/broker/` | Bind address + auth code |
| 8 | SQLite for runs | `src/broker/` | `bun:sqlite` or `better-sqlite3` import |
| 9 | `src/broker/adapters.ts` normalizes three hostile formats | Read file | Codex/Claude/OpenCode branches |
| 10 | `src/broker/recovery.ts` caps at 3 and branches on failure kind | Read file | `maxAttempts = 3` + classifier |
| 11 | `src/core/loop.ts` does no I/O, holds no globals, never throws for tool failures | Read file | Module-level + try/catch |
| 12 | Patch of `@opentui/core@0.4.5` under `patches/` | `patches/` directory + `bun.lock` | Patch file present + patch ref in lockfile |
| 13 | Bun/TS strict mode + `noUnusedLocals`/`noUnusedParameters`/`noUncheckedIndexedAccess` | `tsconfig.json` | JSON flag check |
| 14 | Qodo findings ↔ commit hashes (10 commits + 2 PRs) | `git log --oneline --all` | Hash existence |
| 15 | `bench/` with hidden overlays | `bench/` directory | Hidden overlay dir |
| 16 | `doctor` runs against real TrueForge | `src/cli.ts` + `src/backend/trueforge.ts` | doctor handler |
| 17 | `gitleaks` in CI | `.github/workflows/` | Workflow YAML |
| 18 | Container isolation fixture | test config + `ROCKY_CONTAINER_TEST` | Reference in test |

## Workflow order

1. Create plan (this file) — done.
2. Read source files & verify each claim, recording evidence inline.
3. Run `bun test` to confirm test count + timing.
4. Cross-check Qodo commit hashes via `git log`.
5. Write evidence notes to `outputs/.drafts/rocky-writeup-review-evidence.md`.
6. Write final review to `outputs/rocky-writeup-review.md`.

## Notes on scope

This is not a research paper. It is a hackathon submission writeup. The review criteria above are calibrated: novelty of *engineering*, not novelty of *science*; reproducibility of *claims about this specific codebase*, not of *experimental results*.
