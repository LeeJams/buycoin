import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/core/store.js";

test("state store preserves updates across concurrent writers", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-concurrency-"));
  const stateFile = path.join(baseDir, "state.json");

  const storeA = new StateStore(stateFile);
  const storeB = new StateStore(stateFile);
  await Promise.all([storeA.init(), storeB.init()]);

  const tasks = [];
  for (let i = 0; i < 30; i += 1) {
    tasks.push(
      storeA.update((state) => {
        state.orderEvents.push({
          id: `A-${i}`,
          eventType: "TEST",
          eventTs: new Date().toISOString(),
        });
        return state;
      }),
    );
    tasks.push(
      storeB.update((state) => {
        state.orderEvents.push({
          id: `B-${i}`,
          eventType: "TEST",
          eventTs: new Date().toISOString(),
        });
        return state;
      }),
    );
  }

  await Promise.all(tasks);

  const verifier = new StateStore(stateFile);
  await verifier.init();
  const state = verifier.snapshot();
  assert.equal(state.orderEvents.length, 60);

  const ids = new Set(state.orderEvents.map((item) => item.id));
  assert.equal(ids.size, 60);
});

test("state store recovers stale lock file after restart-like condition", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-stale-lock-"));
  const stateFile = path.join(baseDir, "state.json");
  const lockFile = `${stateFile}.lock`;

  await fs.writeFile(lockFile, "stale", "utf8");
  const staleTs = new Date(Date.now() - 5_000);
  await fs.utimes(lockFile, staleTs, staleTs);

  const store = new StateStore(stateFile, {
    lockStaleMs: 100,
    lockTimeoutMs: 2_000,
    lockRetryMs: 10,
  });
  await store.init();

  const state = store.snapshot();
  assert.equal(state.version, 1);

  let lockExists = true;
  try {
    await fs.stat(lockFile);
  } catch {
    lockExists = false;
  }
  assert.equal(lockExists, false);
});
