import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES } from "../src/config/exit-codes.js";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";

class FailingOrderManagerMock {
  constructor(store) {
    this.store = store;
    this.seq = 0;
  }

  async placeOrder(order) {
    this.seq += 1;
    const id = `mock-order-${this.seq}`;
    await this.store.update((state) => {
      state.orders.push({
        id,
        clientOrderKey: order.clientOrderKey,
        exchangeOrderId: null,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        price: order.price,
        amountKrw: order.amountKrw,
        qty: order.qty,
        remainingQty: order.qty,
        filledQty: 0,
        avgFillPrice: null,
        strategyRunId: order.strategyRunId,
        paper: true,
        state: "UNKNOWN_SUBMIT",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return state;
    });

    return {
      ok: false,
      code: EXIT_CODES.EXCHANGE_RETRYABLE,
      error: {
        message: "temporary exchange failure",
        orderId: id,
        clientOrderKey: order.clientOrderKey,
      },
    };
  }

  async cancelOrder(orderId) {
    await this.store.update((state) => {
      const order = state.orders.find((item) => item.id === orderId);
      if (order) {
        order.state = "CANCELED";
      }
      return state;
    });
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: { orderId, state: "CANCELED" },
    };
  }
}

test("retryable failure is auto-recovered via reconcile", async () => {
  const { config, store } = await createTempStore();
  config.resilience = {
    autoRetryEnabled: true,
    autoRetryAttempts: 1,
    autoRetryDelayMs: 1,
    autoKillSwitchEnabled: true,
    autoKillSwitchFailureThreshold: 3,
    autoKillSwitchWindowSec: 120,
    unknownSubmitMaxAgeSec: 180,
  };
  const orderManager = new FailingOrderManagerMock(store);
  const stateSync = {
    async reconcile() {
      await store.update((state) => {
        const target = state.orders.find((order) => order.state === "UNKNOWN_SUBMIT");
        if (target) {
          target.state = "ACCEPTED";
        }
        return state;
      });
      return { ok: true, code: EXIT_CODES.OK, data: {} };
    },
  };

  const service = new TraderService(config, {
    store,
    orderManager,
    stateSync,
    sleepFn: async () => {},
  });
  await service.init();

  const result = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amount: 5000,
    clientOrderKey: "recover-key-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.autoRecovered, true);
  assert.equal(result.data.state, "ACCEPTED");
});

test("repeated retryable failures trigger auto kill switch", async () => {
  const { config, store } = await createTempStore();
  config.resilience = {
    autoRetryEnabled: true,
    autoRetryAttempts: 1,
    autoRetryDelayMs: 1,
    autoKillSwitchEnabled: true,
    autoKillSwitchFailureThreshold: 2,
    autoKillSwitchWindowSec: 300,
    unknownSubmitMaxAgeSec: 180,
  };
  const orderManager = new FailingOrderManagerMock(store);
  const stateSync = {
    async reconcile() {
      return {
        ok: false,
        code: EXIT_CODES.RECONCILE_MISMATCH,
        error: { message: "still unknown" },
      };
    },
  };

  const service = new TraderService(config, {
    store,
    orderManager,
    stateSync,
    sleepFn: async () => {},
  });
  await service.init();

  const first = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amount: 5000,
    clientOrderKey: "fail-key-1",
  });
  const second = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amount: 5000,
    clientOrderKey: "fail-key-2",
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(service.store.snapshot().settings.killSwitch, true);
});

test("old UNKNOWN_SUBMIT order can trigger auto kill switch on retry path", async () => {
  const { config, store } = await createTempStore();
  config.resilience = {
    autoRetryEnabled: true,
    autoRetryAttempts: 1,
    autoRetryDelayMs: 1,
    autoKillSwitchEnabled: true,
    autoKillSwitchFailureThreshold: 99,
    autoKillSwitchWindowSec: 300,
    unknownSubmitMaxAgeSec: 1,
  };
  const orderManager = new FailingOrderManagerMock(store);
  const stateSync = {
    async reconcile() {
      return {
        ok: false,
        code: EXIT_CODES.RECONCILE_MISMATCH,
        error: { message: "still unknown" },
      };
    },
  };

  const oldTs = new Date(Date.now() - 5_000).toISOString();
  await store.update((state) => {
    state.orders.push({
      id: "old-unknown-1",
      clientOrderKey: "old-unknown-key",
      exchangeOrderId: null,
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      amountKrw: 5000,
      qty: 3.4,
      remainingQty: 3.4,
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId: "manual",
      paper: true,
      state: "UNKNOWN_SUBMIT",
      createdAt: oldTs,
      updatedAt: oldTs,
    });
    return state;
  });

  const service = new TraderService(config, {
    store,
    orderManager,
    stateSync,
    sleepFn: async () => {},
  });
  await service.init();

  const result = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amount: 5000,
    clientOrderKey: "old-unknown-key",
  });

  assert.equal(result.ok, false);
  assert.equal(service.store.snapshot().settings.killSwitch, true);
});
