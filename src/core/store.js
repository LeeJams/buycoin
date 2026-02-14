import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../lib/time.js";

function initialState() {
  return {
    version: 1,
    settings: {
      paperMode: true,
      killSwitch: false,
      killSwitchReason: null,
      killSwitchAt: null,
    },
    orders: [],
    orderEvents: [],
    fills: [],
    balancesSnapshot: [],
    holdings: [],
    marketData: {
      ticks: [],
      candles: [],
    },
    strategyRuns: [],
    riskEvents: [],
    agentAudit: [],
    systemHealth: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeState(state) {
  const base = initialState();
  const normalized = {
    ...base,
    ...(state || {}),
    settings: {
      ...base.settings,
      ...(state?.settings || {}),
    },
    marketData: {
      ...base.marketData,
      ...(state?.marketData || {}),
    },
  };

  delete normalized.proposals;
  delete normalized.approvals;
  return normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateStore {
  constructor(stateFile, options = {}) {
    this.stateFile = stateFile;
    this.lockFile = `${this.stateFile}.lock`;
    this.lockRetryMs = Number.isFinite(options.lockRetryMs) ? options.lockRetryMs : 25;
    this.lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : 5_000;
    this.lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : 30_000;
    this.state = null;
  }

  async init() {
    const dir = path.dirname(this.stateFile);
    await fs.mkdir(dir, { recursive: true });

    await this.withLock(async () => {
      const loaded = await this.readStateOrNull();
      if (loaded) {
        this.state = normalizeState(loaded);
        return;
      }

      this.state = normalizeState(initialState());
      await this.persistUnsafe();
    });

    return this.state;
  }

  snapshot() {
    return this.state;
  }

  async readStateOrNull() {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async refreshFromDisk() {
    const loaded = await this.readStateOrNull();
    if (!loaded) {
      this.state = normalizeState(initialState());
      return this.state;
    }

    this.state = normalizeState(loaded);
    return this.state;
  }

  async withLock(task) {
    const start = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockFile, "wx");
        try {
          return await task();
        } finally {
          await handle.close();
          await fs.rm(this.lockFile, { force: true });
        }
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }

        const recovered = await this.recoverStaleLock();
        if (recovered) {
          continue;
        }

        if (Date.now() - start >= this.lockTimeoutMs) {
          throw new Error(`State lock timeout: ${this.lockFile}`, { cause: error });
        }

        await sleep(this.lockRetryMs);
      }
    }
  }

  async recoverStaleLock() {
    try {
      const stats = await fs.stat(this.lockFile);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < this.lockStaleMs) {
        return false;
      }

      await fs.rm(this.lockFile, { force: true });
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      return false;
    }
  }

  async persistUnsafe() {
    this.state = normalizeState(this.state);
    this.state.updatedAt = nowIso();
    const tempFile = `${this.stateFile}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tempFile, this.stateFile);
  }

  async persist() {
    await this.withLock(async () => {
      await this.persistUnsafe();
    });
  }

  async update(mutator) {
    return this.withLock(async () => {
      await this.refreshFromDisk();
      const next = mutator(this.state);
      if (next) {
        this.state = next;
      }
      await this.persistUnsafe();
      return this.state;
    });
  }

  getOpenOrders() {
    return this.state.orders.filter((order) =>
      ["NEW", "ACCEPTED", "PARTIAL", "CANCEL_REQUESTED", "UNKNOWN_SUBMIT"].includes(order.state),
    );
  }

  findOrderById(orderId) {
    return this.state.orders.find((order) => order.id === orderId || order.exchangeOrderId === orderId);
  }

  findOrderByClientOrderKey(clientOrderKey) {
    return this.state.orders.find((order) => order.clientOrderKey === clientOrderKey);
  }
}
