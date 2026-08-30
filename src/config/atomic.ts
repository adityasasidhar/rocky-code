/**
 * Crash-safe, concurrency-safe writes for the two files Rocky owns outright:
 * `~/.config/rocky/config.json` and `~/.rocky/credentials.json`.
 *
 * Both are read-modify-write: `/connect` splices one entry into a registry it
 * just read. A plain `writeFileSync` makes that pattern lossy twice over — a
 * crash mid-write leaves a truncated file where a config used to be, and two
 * Rocky sessions registering providers at the same moment each write back the
 * registry they read, so the slower one silently erases the faster one's entry.
 *
 * The fix is the usual pair: write a sibling temp file and `rename` it over the
 * target (atomic within a directory, so a reader sees the old file or the new
 * one and never a half of either), and hold an exclusive lock across the whole
 * read-modify-write rather than just the write.
 *
 * The lock is a file created `wx`, which is atomic on every filesystem Rocky
 * runs on. A process that dies holding one would otherwise wedge every later
 * write, so a lock older than `LOCK_STALE_MS` is broken only after its owner
 * is known to have died rather than merely presumed dead from its age.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** How long to wait for another process to finish its write before giving up. */
const LOCK_TIMEOUT_MS = 5_000;
/** A lock this old belonged to a process that died; break it. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;

export class LockTimeout extends Error {
  constructor(readonly path: string) {
    super(
      `timed out waiting for ${path} — another Rocky process is writing it. ` +
        `If none is running, delete the lock file and retry.`,
    );
    this.name = "LockTimeout";
  }
}

/**
 * Write via a sibling temp file and `rename`, fsyncing before the swap so the
 * contents are on disk before the name points at them. The temp file is
 * created with the final mode: a credentials file must never exist, even for
 * an instant, as 0644.
 */
export function writeFileAtomic(
  path: string,
  data: string,
  opts: { mode?: number; dirMode?: number } = {},
): void {
  const dir = dirname(path);
  mkdirSync(dir, {
    recursive: true,
    ...(opts.dirMode === undefined ? {} : { mode: opts.dirMode }),
  });
  // mkdir does not change an existing directory's mode. Tighten the
  // credentials directory before a lock or temp file lands in it.
  if (opts.dirMode !== undefined) chmodSync(dir, opts.dirMode);

  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", opts.mode ?? 0o644);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // `openSync`'s mode is masked by the umask; this is not.
    if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
    renameSync(tmp, path);
    syncDirectory(dir);
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; the throw below is the one that matters.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or we cannot — either way, report the real error.
    }
    throw e;
  }
}

/** Persist the rename's directory entry where the platform supports it. */
function syncDirectory(dir: string): void {
  // Windows does not permit opening a directory as a regular descriptor.
  if (process.platform === "win32") return;

  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch (e) {
    // Some filesystems expose directories but cannot fsync them. The rename is
    // still atomic there; do not reject an otherwise valid write for that.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const isStale = (lock: string, staleMs: number): boolean => {
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    // Gone between the failed create and this stat: not stale, just contended.
    return false;
  }
};

export type LockOptions = {
  /** How long to wait for a contended lock. */
  timeoutMs?: number;
  /** How old a dead lock must be before Rocky attempts recovery. */
  staleMs?: number;
  /** Restrict the lock's parent directory before creating it. */
  dirMode?: number;
};

type LockOwner = { pid: number; token: string };
type HeldLock = LockOwner & { fd: number };

const lockText = ({ pid, token }: LockOwner): string => `${JSON.stringify({ pid, token })}\n`;

function readLock(lock: string): { owner: LockOwner; raw: string } | undefined {
  try {
    const raw = readFileSync(lock, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof record["pid"] !== "number" ||
      !Number.isInteger(record["pid"]) ||
      record["pid"] <= 0 ||
      typeof record["token"] !== "string" ||
      record["token"] === ""
    ) {
      return undefined;
    }
    return { owner: parsed as LockOwner, raw };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is owned by another user. Failing safe here may
    // delay a write; deleting it would allow concurrent critical sections.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function deadStaleLock(lock: string, staleMs: number): { owner: LockOwner; raw: string } | undefined {
  const known = readLock(lock);
  if (!known || !isStale(lock, staleMs) || processIsAlive(known.owner.pid)) return undefined;
  return known;
}

function acquireLock(lock: string): HeldLock | undefined {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw e;
  }

  const held: HeldLock = { fd, pid: process.pid, token: randomUUID() };
  try {
    writeSync(fd, lockText(held));
    fsyncSync(fd);
    return held;
  } catch (e) {
    try {
      closeSync(fd);
    } finally {
      // A successor cannot exist until this path has gone.
      try {
        unlinkSync(lock);
      } catch {
        // Preserve the write failure.
      }
    }
    throw e;
  }
}

function releaseLock(lock: string, held: HeldLock): void {
  try {
    closeSync(held.fd);
  } catch {
    // The owner check below, not closing, determines whether this releases it.
  }
  const current = readLock(lock);
  if (current?.owner.token !== held.token) return;
  try {
    unlinkSync(lock);
  } catch {
    // A manual removal is already a released lock.
  }
}

/**
 * Serialize stale-lock eviction separately from ordinary acquisition. This
 * prevents two contenders from inspecting an old lock and one later unlinking
 * the successor the other contender acquired after the eviction.
 */
function breakDeadLock(lock: string, staleMs: number): void {
  const reaper = `${lock}.reap`;
  const held = acquireLock(reaper);
  if (!held) return;
  try {
    const stale = deadStaleLock(lock, staleMs);
    if (!stale) return;
    // Recheck the exact record while holding the reaper guard. A user replacing
    // the lock manually cannot be mistaken for its dead predecessor.
    if (readFileSync(lock, "utf8") !== stale.raw) return;
    unlinkSync(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  } finally {
    releaseLock(reaper, held);
  }
}

/**
 * Run `fn` holding an exclusive lock on `path`, so a read-modify-write of that
 * file cannot interleave with another process's.
 *
 * Not reentrant: taking the same lock inside `fn` waits for a lock `fn` itself
 * is holding, and then times out. Every caller here takes it once, at the top.
 */
export function withFileLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const lock = `${path}.lock`;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const dir = dirname(path);
  mkdirSync(dir, {
    recursive: true,
    ...(opts.dirMode === undefined ? {} : { mode: opts.dirMode }),
  });
  if (opts.dirMode !== undefined) chmodSync(dir, opts.dirMode);

  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  let held: HeldLock | undefined;
  for (;;) {
    held = acquireLock(lock);
    if (held) break;
    breakDeadLock(lock, staleMs);
    if (Date.now() >= deadline) throw new LockTimeout(lock);
    Bun.sleepSync(LOCK_POLL_MS);
  }

  try {
    return fn();
  } finally {
    releaseLock(lock, held);
  }
}
