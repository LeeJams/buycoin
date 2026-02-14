import test from "node:test";
import assert from "node:assert/strict";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";
import { EXIT_CODES } from "../src/config/exit-codes.js";

class SymbolSelectorMock {
  async select() {
    return {
      symbol: "ETH_KRW",
      mode: "momentum",
      reason: "mock_pick",
      score: 1,
      metrics: {
        lastPrice: 1_000_000,
        changeRate: 0.01,
        accTradeValue24h: 100_000_000_000,
      },
      ranked: [],
      failures: [],
    };
  }
}

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

test("trader service places order using auto-selected symbol", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, {
    store,
    symbolSelector: new SymbolSelectorMock(),
    exchangeClient: new ExchangeMock(),
  });
  await service.init();

  const placed = await service.placeOrderDirect({
    autoSymbol: true,
    side: "buy",
    type: "limit",
    price: 6000,
    amount: 6000,
    clientOrderKey: "auto-symbol-key-1",
  });

  assert.equal(placed.ok, true);
  assert.equal(placed.data.symbol, "ETH_KRW");
  assert.equal(placed.data.amountKrw, 6000);
  assert.equal(placed.data.qty, 1);
  assert.equal(placed.data.autoSelection.symbol, "ETH_KRW");
});

test("trader service enforces ai order-count hard cap for auto-selected symbol orders", async () => {
  const { config, store } = await createTempStore();
  config.trading.aiMaxOrdersPerWindow = 1;
  config.trading.aiOrderCountWindowSec = 60;

  await store.update((state) => {
    const now = new Date().toISOString();
    state.orders.push({
      id: "recent-existing-1",
      clientOrderKey: "recent-existing-1",
      exchangeOrderId: "recent-existing-ex-1",
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 6000,
      qty: 1,
      amountKrw: 6000,
      remainingQty: 0,
      filledQty: 1,
      avgFillPrice: 6000,
      strategyRunId: "manual",
      paper: true,
      state: "FILLED",
      createdAt: now,
      updatedAt: now,
      correlationId: "corr-recent-1",
    });
    return state;
  });

  const service = new TraderService(config, {
    store,
    symbolSelector: new SymbolSelectorMock(),
    exchangeClient: new ExchangeMock(),
  });
  await service.init();

  const placed = await service.placeOrderDirect({
    autoSymbol: true,
    side: "buy",
    type: "limit",
    price: 6000,
    amount: 6000,
    clientOrderKey: "auto-symbol-cap-hit-1",
  });

  assert.equal(placed.ok, false);
  assert.equal(placed.code, EXIT_CODES.RISK_REJECTED);
  assert.equal(placed.error.reasons.some((item) => item.rule === "AI_MAX_ORDERS_PER_WINDOW"), true);
});
