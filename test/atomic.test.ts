import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LockTimeout, withFileLock, writeFileAtomic } from "../src/config/atomic.ts";
import { cleanup, tempDir } from "./helpers.ts";

let dir: string;
beforeEach(() => (dir = tempDir()));
afterEach(() => cleanup(dir));

/** chmod-based tests are meaningless as root, which ignores the bits. */
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("writeFileAtomic", () => {
  test("creates the file and its directory", () => {
    const path = join(dir, "nested", "config.json");
    writeFileAtomic(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  test("applies the mode even when the file already exists at another mode", () => {
    const path = join(dir, "credentials.json");
    writeFileSync(path, "old", { mode: 0o644 });
    chmodSync(path, 0o644);
    writeFileAtomic(path, "new", { mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("leaves no temp file behind on success", () => {
    writeFileAtomic(join(dir, "config.json"), "{}\n");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a failed write leaves the previous file intact and drops the temp", () => {
    const sub = join(dir, "sub");
    const path = join(sub, "config.json");
    writeFileAtomic(path, "original");
    if (asRoot) return;
    chmodSync(sub, 0o500);
    try {
      expect(() => writeFileAtomic(path, "replacement")).toThrow();
      // The point of the rename: a reader never sees a half-written config.
      expect(readFileSync(path, "utf8")).toBe("original");
      expect(readdirSync(sub).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      chmodSync(sub, 0o700);
    }
  });
});

describe("withFileLock", () => {
  test("returns the callback's value and releases the lock", () => {
    const path = join(dir, "config.json");
    expect(withFileLock(path, () => 42)).toBe(42);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("releases the lock even when the callback throws", () => {
    const path = join(dir, "config.json");
    expect(() =>
      withFileLock(path, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${path}.lock`)).toBe(false);
    // Still usable afterwards, which is the part a leaked lock would break.
    expect(withFileLock(path, () => "ok")).toBe("ok");
  });

  test("a held lock blocks a second holder", () => {
    const path = join(dir, "config.json");
    writeFileSync(`${path}.lock`, "");
    // Freshly created, so it is contended rather than stale: the wait runs out.
    expect(() => withFileLock(path, () => "never", { timeoutMs: 100 })).toThrow(LockTimeout);
  });

  test("a lock left by a dead process is broken rather than waited on", () => {
    const path = join(dir, "config.json");
    const lock = `${path}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }));
    const old = new Date(Date.now() - 120_000); // past LOCK_STALE_MS
    utimesSync(lock, old, old);
    expect(withFileLock(path, () => "recovered")).toBe("recovered");
    expect(existsSync(lock)).toBe(false);
  });

  test("a stale-looking lock owned by a live process is never evicted", () => {
    const path = join(dir, "config.json");
    const lock = `${path}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "live-owner" }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(() => withFileLock(path, () => "never", { timeoutMs: 100 })).toThrow(LockTimeout);
    expect(existsSync(lock)).toBe(true);
  });

  test("a holder never releases a lock whose token changed", () => {
    const path = join(dir, "config.json");
    const lock = `${path}.lock`;
    withFileLock(path, () => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "successor" }));
    });
    expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({ pid: process.pid, token: "successor" });
  });
});
