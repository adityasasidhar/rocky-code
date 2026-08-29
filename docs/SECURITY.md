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

## Provider credentials

A key registered with `/connect` (or `rocky providers login`) is written to `~/.rocky/credentials.json` at mode `0600` — never to a config file. `src/config/write.ts` refuses to serialize a value under a secret-shaped key (`apiKey`, `token`, `secret`, …), so a config file stays safe to commit or paste into an issue; only the variable *name* (`apiKeyEnv`) is ever recorded there. Wizard answers are excluded from `~/.rocky/history` and a pasted key is echoed to scrollback as `••••••••`. An environment variable named by `apiKeyEnv` takes precedence over a stored key, and `/provider remove` deletes the entry and its key together so no orphaned credential is left behind.

The key is masked as it is typed: `/connect` collects it in a dialog that owns the keyboard and holds the value in a plain local, so only its length ever reaches the screen. Two limits remain: `rocky providers login` runs under a shell readline that cannot mask, and says so before echoing; and `credentials.json` is chmod-protected but not encrypted — the same posture as the broker token.

The models.dev catalogue is fetched over HTTPS and cached at `~/.cache/rocky/models.json`. It carries no credentials, is never sent anything, and a failed fetch degrades to a built-in list rather than blocking.

The broker trusts a valid bearer-authenticated call as originating from the configured TrueForge MCP connector. Do not expose port 8791, share its token, or remove the TrueForge approval rules.
