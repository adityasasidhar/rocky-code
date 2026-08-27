import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config/schema.ts";
import { createArchiver } from "../src/core/archive.ts";
import type { ToolContext } from "../src/tools/types.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rocky-test-"));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function makeCtx(
  cwd: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  const sessionDir = join(cwd, ".rocky-session");
  const ctx: ToolContext = {
    cwd,
    setCwd(dir) {
      ctx.cwd = dir;
    },
    sessionDir,
    archive: createArchiver(sessionDir),
    config: defaultConfig(),
    signal: new AbortController().signal,
    ...overrides,
  };
  return ctx;
}
