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
 * write, so a lock older than `LOCK_STALE_MS` is broken rather than waited on.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
  /** How old a lock must be to count as abandoned. */
  staleMs?: number;
};

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
  mkdirSync(dirname(path), { recursive: true });

  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isStale(lock, staleMs)) {
        try {
          unlinkSync(lock);
        } catch {
          // Someone else broke it first; loop and try to take it.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeout(lock);
      Bun.sleepSync(LOCK_POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort; the unlink below is what actually releases the lock.
    }
    try {
      unlinkSync(lock);
    } catch {
      // Broken as stale by another process, or the directory went away.
    }
  }
}
