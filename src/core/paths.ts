import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a model-supplied path against the session cwd.
 *
 * Rocky does NOT jail tools to the project root: a coding agent legitimately
 * reads /etc/hosts, ~/.gitconfig, and sibling repos, and `bash` could escape a
 * jail trivially anyway. Containment is the permission engine's job, not this
 * function's. What this does guarantee is that every tool resolves paths the
 * same way, so the path shown in a permission prompt is the path that is used.
 */
export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Render a path relative to cwd when that's shorter, for display only. */
export function displayPath(cwd: string, p: string): string {
  const abs = resolvePath(cwd, p);
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}
