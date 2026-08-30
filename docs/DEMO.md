# Three-minute demo script

## Before recording

- Run TrueForge locally: `npx @truefoundry/trueforge@latest` (serves port 8790).
- In its UI: **Settings → Models** (provider + key; note the FQN is `provider/name`,
  e.g. `openai/gpt-5-4-mini`) and **Settings → Sandbox providers** (Daytona + API key).
  Without the sandbox provider every snapshot-carrying turn fails — confirm with `rocky doctor`.
- Build at least two pinned worker images and enable them in `.rocky/config.json`.
- Use a small owned fixture repository and a deterministic failing test.
- Run `bun test` and `bunx tsc --noEmit` in Rocky itself.

## Timeline

**0:00–0:25 — premise and health.** Introduce Rocky as a self-healing meta coding agent. Run `rocky doctor`. Point out live TrueForge, Daytona, broker, Docker, worker images, credentials-present checks, and snapshot safety.

**0:25–0:55 — submit the task.** Start Rocky. Show the footer's TrueForge connection, session, sandbox, enabled workers, and planning phase. Submit the known failing task.

**0:55–1:25 — orchestration.** Show TrueForge creating a dynamic exploration thread, calling `worker_recommend`, and explaining the selected worker. The worker card should show its isolated container and normalized tool activity.

**1:25–1:55 — recovery.** Deliberately keep one configured worker image unavailable. Show the classified failure and bounded switch to the next eligible worker; mention the three-attempt ceiling.

**1:55–2:25 — independent validation.** Show the returned candidate patch, then Daytona applying it to a fresh snapshot copy and running the acceptance check. Distinguish the worker's claim from Daytona's result.

**2:25–2:45 — approval boundary.** Stop on the TrueForge approval dialog. Show affected files, patch stats, tests, and destination. Verify the real file is still unchanged.

**2:45–3:00 — apply and reconnect.** Approve. Show the checkpointed workspace mutation and passing local test. Restart Rocky, run `/sessions`, and replay the persisted session.
