import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Per-project permission grants the user chose to persist.
 *
 * Separate from `.rocky/config.json` on purpose: config is authored by a human
 * and belongs in version control; this file is written by Rocky in response to
 * "always allow", and should not be silently rewritten by an editor.
 */
export const SettingsSchema = z.object({
  /** Bash command rules, e.g. "bun test". */
  allow: z.array(z.string()).default([]),
  /** Whole tools blanket-approved, e.g. "edit_file". A bash rule can never
   *  express this, so it gets its own bucket. */
  allowTools: z.array(z.string()).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const settingsPath = (projectDir: string): string =>
  join(projectDir, ".rocky", "settings.json");

const EMPTY: Settings = { allow: [], allowTools: [] };

/** Never throws: a corrupt settings file must not stop a session. */
export function loadSettings(projectDir: string): Settings {
  const path = settingsPath(projectDir);
  if (!existsSync(path)) return EMPTY;
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Append a grant, de-duplicated. Returns false if it could not be written. */
export function persistAllow(
  projectDir: string,
  grant: { kind: "bash"; rule: string } | { kind: "tool"; name: string },
): boolean {
  try {
    const current = loadSettings(projectDir);
    const next: Settings =
      grant.kind === "bash"
        ? { ...current, allow: dedupe([...current.allow, grant.rule]) }
        : { ...current, allowTools: dedupe([...current.allowTools, grant.name]) };

    const path = settingsPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)].sort();
