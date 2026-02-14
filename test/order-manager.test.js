import test from "node:test";
import assert from "node:assert/strict";
import { OrderManager } from "../src/core/order-manager.js";
import { createTempStore } from "../test-utils/helpers.js";

class ExchangeMock {
  isRetryableError() {
    return false;
  }

  async placeOrder() {
    return { orderId: "mock-order-id" };
  }

  async cancelOrder() {
    return { ok: true };
  }
}

class ExchangeSnakeCaseMock {
  isRetryableError() {
    return false;
  }

  async placeOrder() {
    return { order_id: "mock-order-id-snake" };
  }
}

class CancelFallbackExchangeMock {
  constructor() {
    this.cancelCalls = [];
    this.lookupCalls = [];
  }

  isRetryableError() {
    return false;
  }

  async getOrderStatus(params) {
    this.lookupCalls.push(params);
    return {
      uuid: "resolved-exchange-uuid-1",
      state: "wait",
    };
  }

  async cancelOrder(params) {
    this.cancelCalls.push(params);
    return { ok: true };
  }
}

test("order manager places paper order and cancels it", async () => {
  const { config, store } = await createTempStore();
  const manager = new OrderManager(config, store, new ExchangeMock(), console);
  const placed = await manager.placeOrder(
    {
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 100,
      qty: 1,
      strategyRunId: "test-run",
    },
    { paperMode: true },
  );

  assert.equal(placed.ok, true);
  assert.equal(placed.data.state, "ACCEPTED");

  const canceled = await manager.cancelOrder(placed.data.id, { paperMode: true });
  assert.equal(canceled.ok, true);
  assert.equal(canceled.data.state, "CANCELED");
});

test("order manager returns existing order for duplicate client order key", async () => {
  const { config, store } = await createTempStore();
  const manager = new OrderManager(config, store, new ExchangeMock(), console);
  const clientOrderKey = "dup-key";

  const first = await manager.placeOrder(
    {
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 100,
      qty: 1,
      strategyRunId: "test-run",
      clientOrderKey,
    },
    { paperMode: true },
  );
  assert.equal(first.ok, true);

  const second = await manager.placeOrder(
    {
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 100,
      qty: 1,
      strategyRunId: "test-run",
      clientOrderKey,
    },
    { paperMode: true },
  );

  assert.equal(second.ok, true);
  assert.equal(second.data.id, first.data.id);
  assert.equal(second.data.idempotentHit, true);
});

test("order manager maps exchange order_id field", async () => {
  const { config, store } = await createTempStore();
  const manager = new OrderManager(config, store, new ExchangeSnakeCaseMock(), console);

  const placed = await manager.placeOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      qty: 3.4,
      strategyRunId: "test-run",
      clientOrderKey: "snake-order-id-key",
    },
    { paperMode: false },
  );

  assert.equal(placed.ok, true);
  assert.equal(placed.data.exchangeOrderId, "mock-order-id-snake");
  assert.equal(placed.data.state, "ACCEPTED");
});

test("order manager resolves missing exchangeOrderId before cancel", async () => {
  const { config, store } = await createTempStore();
  const exchange = new CancelFallbackExchangeMock();
  const manager = new OrderManager(config, store, exchange, console);

  await store.update((state) => {
    state.orders.push({
      id: "order-no-ex-id-1",
      clientOrderKey: "client-key-need-lookup",
      exchangeOrderId: null,
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      amountKrw: 5000,
      qty: 3.4083163,
      remainingQty: 3.4083163,
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId: "manual",
      paper: false,
      state: "ACCEPTED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      correlationId: "corr-1",
    });
    return state;
  });

  const canceled = await manager.cancelOrder("order-no-ex-id-1", {
    paperMode: false,
  });

  assert.equal(canceled.ok, true);
  assert.equal(exchange.lookupCalls.length, 1);
  assert.equal(exchange.cancelCalls.length, 1);
  assert.equal(exchange.cancelCalls[0].exchangeOrderId, "resolved-exchange-uuid-1");

  const after = store.findOrderById("order-no-ex-id-1");
  assert.equal(after.exchangeOrderId, "resolved-exchange-uuid-1");
  assert.equal(after.state, "CANCELED");
});
