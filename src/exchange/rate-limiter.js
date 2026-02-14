function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

export class PerSecondSlidingWindowLimiter {
  constructor({ maxPerSec = 1, nowFn = () => Date.now(), sleepFn = sleep } = {}) {
    this.maxPerSec = toPositiveInt(maxPerSec, 1);
    this.nowFn = nowFn;
    this.sleepFn = sleepFn;
    this.timestamps = [];
    this.lock = Promise.resolve();
  }

  prune(nowMs) {
    const cutoff = nowMs - 1000;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  async takeOne() {
    while (true) {
      const nowMs = this.nowFn();
      this.prune(nowMs);

      if (this.timestamps.length < this.maxPerSec) {
        this.timestamps.push(nowMs);
        return;
      }

      const earliest = this.timestamps[0];
      const waitMs = Math.max(1, earliest + 1000 - nowMs);
      await this.sleepFn(waitMs);
    }
  }

  async take(count = 1) {
    const total = toPositiveInt(count, 1);

    let unlock = null;
    const previous = this.lock;
    this.lock = new Promise((resolve) => {
      unlock = resolve;
    });

    await previous;
    try {
      for (let i = 0; i < total; i += 1) {
        await this.takeOne();
      }
    } finally {
      unlock();
    }
  }
}

// Backward compatible alias for existing imports.
export const TokenBucketLimiter = PerSecondSlidingWindowLimiter;
