import test from "node:test";
import assert from "node:assert/strict";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";

class ExchangePrivateOrderMock {
  constructor() {
    this.calls = [];
  }

  isRetryableError() {
    return false;
  }

  async getOrderChance(params) {
    this.calls.push({ fn: "getOrderChance", params });
    return {
      market: { id: "KRW-USDT" },
      bid_fee: "0.0025",
    };
  }

  async listOrders(params) {
    this.calls.push({ fn: "listOrders", params });
    return [{ uuid: "order-1", state: "wait" }];
  }

  async getOrderStatus(params) {
    this.calls.push({ fn: "getOrderStatus", params });
    return {
      uuid: "resolved-uuid-1",
      state: "wait",
    };
  }

  async getOrder(params) {
    this.calls.push({ fn: "getOrder", params });
    return {
      uuid: params.exchangeOrderId,
      state: "wait",
      market: "KRW-USDT",
    };
  }

  async cancelOrder(params) {
    this.calls.push({ fn: "cancelOrder", params });
    return {
      uuid: params.exchangeOrderId,
      state: "cancel",
      market: "KRW-USDT",
    };
  }
}

class OrderManagerSpy {
  constructor() {
    this.placeCalls = [];
  }

  async placeOrder(order) {
    this.placeCalls.push(order);
    return {
      ok: true,
      code: 0,
      data: {
        id: "placed-1",
        exchangeOrderId: "ex-placed-1",
        symbol: order.symbol,
      },
    };
  }
}

test("trader service order chance calls private chance API", async () => {
  const { config, store } = await createTempStore();
  const exchange = new ExchangePrivateOrderMock();
  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
  });
  await service.init();

  const res = await service.getOrderChance("USDT_KRW");
  assert.equal(res.ok, true);
  assert.equal(res.data.symbol, "USDT_KRW");
  assert.equal(res.data.market, "KRW-USDT");
  assert.equal(exchange.calls[0].fn, "getOrderChance");
  assert.equal(exchange.calls[0].params.symbol, "USDT_KRW");
});

test("trader service order list forwards query options", async () => {
  const { config, store } = await createTempStore();
  const exchange = new ExchangePrivateOrderMock();
  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
  });
  await service.init();

  const res = await service.listOrders({
    symbol: "USDT_KRW",
    states: ["wait", "done"],
    page: 2,
    limit: 10,
    orderBy: "asc",
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.count, 1);
  assert.equal(exchange.calls[0].fn, "listOrders");
  assert.equal(exchange.calls[0].params.symbol, "USDT_KRW");
  assert.deepEqual(exchange.calls[0].params.states, ["wait", "done"]);
  assert.equal(exchange.calls[0].params.page, 2);
  assert.equal(exchange.calls[0].params.limit, 10);
  assert.equal(exchange.calls[0].params.orderBy, "asc");
});

test("trader service order get resolves missing exchange UUID from client key", async () => {
  const { config, store } = await createTempStore();
  const exchange = new ExchangePrivateOrderMock();
  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
  });
  await service.init();

  await store.update((state) => {
    state.orders.push({
      id: "local-order-1",
      clientOrderKey: "client-key-1",
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
      paper: false,
      state: "ACCEPTED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      correlationId: "corr-1",
    });
    return state;
  });

  const res = await service.getOrder("local-order-1");
  assert.equal(res.ok, true);
  assert.equal(res.data.source, "exchange");
  assert.equal(res.data.exchangeOrderId, "resolved-uuid-1");

  const after = store.findOrderById("local-order-1");
  assert.equal(after.exchangeOrderId, "resolved-uuid-1");
});

test("trader service rejects live order when dynamic exchange minimum is not met", async () => {
  const { config, store } = await createTempStore();
  const exchange = new ExchangePrivateOrderMock();
  const orderManager = new OrderManagerSpy();
  exchange.getOrderChance = async (params) => {
    exchange.calls.push({ fn: "getOrderChance", params });
    return {
      market: {
        id: "KRW-USDT",
        bid: { min_total: "7000" },
        ask: { min_total: "7000" },
      },
    };
  };

  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
    orderManager,
  });
  await service.init();
  await service.setPaperMode(false, "test live mode");

  const res = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1468,
    amount: 5000,
    clientOrderKey: "dyn-min-reject-1",
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.equal(res.error.reasons.some((item) => item.rule === "MIN_ORDER_NOTIONAL_KRW"), true);
  assert.equal(res.error.metrics.appliedMinOrderNotional, 7000);
  assert.equal(res.error.metrics.dynamicMinOrderNotional, 7000);
  assert.equal(orderManager.placeCalls.length, 0);
});

test("trader service can cancel by exchange uuid without local order", async () => {
  const { config, store } = await createTempStore();
  const exchange = new ExchangePrivateOrderMock();
  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
  });
  await service.init();
  await service.setPaperMode(false, "test live mode");

  const res = await service.cancelOrder("uuid-direct-1", {
    symbol: "USDT_KRW",
  });

  assert.equal(res.ok, true);
  assert.equal(res.data.source, "exchange-direct");
  assert.equal(res.data.exchangeOrderId, "uuid-direct-1");
  const cancelCall = exchange.calls.find((item) => item.fn === "cancelOrder");
  assert.equal(cancelCall.params.exchangeOrderId, "uuid-direct-1");
  assert.equal(cancelCall.params.symbol, "USDT_KRW");
});
