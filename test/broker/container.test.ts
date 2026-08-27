import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkerBroker } from "../../src/broker/broker.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { createWorkspaceSnapshot } from "../../src/workspace/snapshot.ts";
import { cleanup, tempDir } from "../helpers.ts";

const containerTest = process.env["ROCKY_CONTAINER_TEST"] === "1" ? test : test.skip;

let dir: string;
let broker: WorkerBroker | undefined;
beforeEach(() => {
  dir = tempDir();
  Bun.spawnSync(["git", "-C", dir, "init", "--quiet"]);
  writeFileSync(join(dir, "input.txt"), "before\n");
});
afterEach(() => {
  broker?.close();
  broker = undefined;
  cleanup(dir);
});

describe("credential-free worker container", () => {
  containerTest("edits only its disposable snapshot and returns a candidate patch", async () => {
    const config = ConfigSchema.parse({
      broker: {
        workers: {
          fixture: {
            enabled: true,
            kind: "fixture",
            image: "rocky-worker-fixture:1",
            timeoutMs: 10_000,
          },
        },
      },
    });
    const snapshot = createWorkspaceSnapshot(dir);
    broker = new WorkerBroker(dir, config);
    const started = broker.start(
      "fixture",
      snapshot.id,
      "fixture-task-0001",
      "printf 'after\\n' > input.txt && printf 'new\\n' > added.txt",
    );

    let status = broker.status(started.id);
    const deadline = Date.now() + 15_000;
    while (status.status === "queued" || status.status === "running") {
      if (Date.now() >= deadline) throw new Error("fixture worker did not finish");
      await Bun.sleep(50);
      status = broker.status(started.id);
    }

    const result = broker.result(started.id);
    expect(result.status).toBe("completed");
    expect(result.patch).toContain("input.txt");
    expect(result.patch).toContain("added.txt");
    expect(Bun.file(join(dir, "input.txt")).text()).resolves.toBe("before\n");

    for (const attempt of [2, 3]) {
      const retry = broker.start(
        "fixture",
        snapshot.id,
        "fixture-task-0001",
        `printf 'attempt ${attempt}\\n' > input.txt`,
      );
      let retryStatus = broker.status(retry.id);
      while (retryStatus.status === "queued" || retryStatus.status === "running") {
        await Bun.sleep(50);
        retryStatus = broker.status(retry.id);
      }
      expect(retryStatus.status).toBe("completed");
    }
    expect(() =>
      broker!.start(
        "fixture",
        snapshot.id,
        "fixture-task-0001",
        "printf 'fourth\\n' > input.txt",
      ),
    ).toThrow(/recovery attempt limit/);
  });
});
