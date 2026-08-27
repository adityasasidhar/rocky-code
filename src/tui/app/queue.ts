/**
 * A promise-based channel between the footer editor and the REPL loop.
 *
 * The editor pushes submitted prompts; the REPL awaits `next()`. Typing during
 * a turn just queues more items — that *is* the type-ahead mechanism, no
 * byte-level machinery required. `close()` ends the REPL (Ctrl-D, /exit).
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: T | undefined) => void)[] = [];
  private closed = false;

  /** Items pushed but not yet consumed (for the queued-prompt strip). */
  get pending(): readonly T[] {
    return this.items;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Resolves queued waiters with `undefined`; queued items still drain. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  /** The next item, or `undefined` once closed and drained. */
  next(): Promise<T | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
