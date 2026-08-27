import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "../../../src/tui/app/queue.ts";

describe("AsyncQueue", () => {
  test("push before next resolves in order", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  test("next before push suspends until an item arrives", async () => {
    const q = new AsyncQueue<string>();
    const pending = q.next();
    q.push("late");
    expect(await pending).toBe("late");
  });

  test("close resolves waiting consumers with undefined", async () => {
    const q = new AsyncQueue<string>();
    const pending = q.next();
    q.close();
    expect(await pending).toBeUndefined();
  });

  test("close drains queued items before reporting end", async () => {
    const q = new AsyncQueue<string>();
    q.push("a");
    q.close();
    expect(await q.next()).toBe("a");
    expect(await q.next()).toBeUndefined();
  });

  test("push after close is dropped", async () => {
    const q = new AsyncQueue<string>();
    q.close();
    q.push("ghost");
    expect(await q.next()).toBeUndefined();
  });

  test("pending reflects unconsumed items", () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    expect([...q.pending]).toEqual([1, 2]);
  });
});
