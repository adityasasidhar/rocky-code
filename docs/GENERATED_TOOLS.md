# Daytona generated-tool contract

Task-specific tools are session-scoped artifacts created only inside the
TrueForge Daytona sandbox. A tool lives at `.rocky-tools/<tool-id>/` and must
contain all of the following before Rocky may use it:

- `manifest.json` with `name`, `purpose`, JSON `inputSchema`, an argv-array
  `command`, and `expectedOutputs`.
- `run` as the restricted entrypoint. It validates input against the manifest,
  fixes the working directory to the tool folder, applies a hard timeout, and
  writes only to paths declared by `expectedOutputs`.
- `test.*` or `tests/` containing at least one deterministic smoke test.

Commands must be relative to the tool folder, must not invoke a shell through
an interpolated string, and must not read provider credentials. TrueForge runs
the tests in Daytona before first use. Rocky may reuse a passing tool during
the same TrueForge session, but never copies it into the real workspace,
loads it into the Rocky/broker process, or persists it across sessions.

Generated tools do not receive a separate route to workspace mutation. Any
candidate changes they help produce still pass Daytona validation and the
one-shot `workspace_apply_patch` approval gate.
