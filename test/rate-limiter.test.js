import test from "node:test";
import assert from "node:assert/strict";
import { PerSecondSlidingWindowLimiter } from "../src/exchange/rate-limiter.js";

test("rate limiter waits when per-second cap is exceeded", async () => {
  let nowMs = 0;
  const sleeps = [];
  const limiter = new PerSecondSlidingWindowLimiter({
    maxPerSec: 2,
    nowFn: () => nowMs,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });

  await limiter.take();
  await limiter.take();
  await limiter.take();

  assert.deepEqual(sleeps, [1000]);
  assert.equal(nowMs, 1000);
});

test("rate limiter serializes concurrent callers under same limit", async () => {
  let nowMs = 0;
  const sleeps = [];
  const limiter = new PerSecondSlidingWindowLimiter({
    maxPerSec: 2,
    nowFn: () => nowMs,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  });

  await Promise.all([1, 2, 3, 4, 5].map(() => limiter.take()));

  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(nowMs, 2000);
});
