# Rocky orchestration security model

Rocky separates candidate generation from workspace mutation.

1. Rocky snapshots tracked and non-ignored untracked files. `.git`, `.rocky`, dependencies, build outputs, `.env*`, credentials, private keys, and configured secret globs are excluded. A SHA-256 manifest anchors the baseline and the default uncompressed limit is 50 MiB.
2. Each worker receives a separately extracted copy under `.rocky/broker/runs/<id>/workspace`. The user's checkout and Docker socket are never mounted.
3. Worker containers use a read-only root, a writable disposable workspace, a bounded tmpfs, dropped Linux capabilities, `no-new-privileges`, and CPU, memory, and PID limits. Only explicitly listed credential environment variables enter the selected container.
4. Workers return candidate patches. TrueForge applies candidates to Daytona and independently runs project checks. Worker claims are evidence, not validation.
5. `workspace_apply_patch` and `workspace_undo` are declared destructive MCP tools and are explicitly included in the TrueForge agent's `requireApprovalForTools` list. TrueForge pauses before invoking them.
6. The broker also requires a 256-bit bearer token, binds only to `127.0.0.1`, validates run/snapshot identifiers, rejects traversal, absolute paths, symlink crossings, binary patches, stale hashes, and patch conflicts, and checkpoints pre-images before applying.
7. Undo refuses to overwrite files changed after application. Generated Daytona tools never load into the Rocky or broker host process.

The bearer token is stored mode `0600` under `.rocky/broker/token` when `ROCKY_BROKER_TOKEN` is absent. Logs redact forwarded credential values and common token formats. `rocky doctor` reports only presence or absence, never secret values.

The broker trusts a valid bearer-authenticated call as originating from the configured TrueForge MCP connector. Do not expose port 8791, share its token, or remove the TrueForge approval rules.
