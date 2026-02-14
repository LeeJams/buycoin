import test from "node:test";
import assert from "node:assert/strict";
import { RiskEngine } from "../src/core/risk-engine.js";
import { createTempStore } from "../test-utils/helpers.js";

test("risk engine rejects order over max notional", async () => {
  const { config, store } = await createTempStore();
  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder({
    symbol: "BTC_KRW",
    side: "buy",
    type: "limit",
    price: config.trading.maxOrderNotionalKrw + 1,
    qty: 1,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons[0].rule, "MAX_ORDER_NOTIONAL_KRW");
});

test("risk engine rejects order below minimum notional", async () => {
  const { config, store } = await createTempStore();
  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1468,
    qty: 1,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "MIN_ORDER_NOTIONAL_KRW"), true);
});

test("risk engine rejects when kill switch is active", async () => {
  const { config, store } = await createTempStore();
  await store.update((state) => {
    state.settings.killSwitch = true;
    state.settings.killSwitchReason = "manual emergency";
    return state;
  });

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder({
    symbol: "BTC_KRW",
    side: "buy",
    type: "limit",
    price: 1000,
    qty: 1,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "KILL_SWITCH_ACTIVE"), true);
});

test("risk engine applies symbol-specific minimum notional override", async () => {
  const { config, store } = await createTempStore();
  config.trading.minOrderNotionalBySymbol = {
    USDT_KRW: 1000,
  };

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1468,
    qty: 1,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.metrics.appliedMinOrderNotional, 1000);
});

test("risk engine applies dynamic minimum notional override from runtime context", async () => {
  const { config, store } = await createTempStore();
  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 6000,
      qty: 1,
    },
    {
      minOrderNotionalKrwOverride: 7000,
    },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "MIN_ORDER_NOTIONAL_KRW"), true);
  assert.equal(result.metrics.dynamicMinOrderNotional, 7000);
  assert.equal(result.metrics.appliedMinOrderNotional, 7000);
});

test("risk engine applies ai max order notional cap for auto-symbol orders", async () => {
  const { config, store } = await createTempStore();
  config.trading.aiMaxOrderNotionalKrw = 7000;

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 8000,
      qty: 1,
    },
    {
      aiSelected: true,
    },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "AI_MAX_ORDER_NOTIONAL_KRW"), true);
});

test("risk engine applies ai order-count cap for auto-symbol orders", async () => {
  const { config, store } = await createTempStore();
  config.trading.aiMaxOrdersPerWindow = 2;
  config.trading.aiOrderCountWindowSec = 60;

  await store.update((state) => {
    const now = new Date().toISOString();
    state.orders.push({
      id: "recent-order-1",
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 10000,
      qty: 1,
      remainingQty: 0,
      filledQty: 1,
      paper: true,
      state: "FILLED",
      createdAt: now,
      updatedAt: now,
    });
    state.orders.push({
      id: "recent-order-2",
      symbol: "ETH_KRW",
      side: "buy",
      type: "limit",
      price: 12000,
      qty: 1,
      remainingQty: 0,
      filledQty: 1,
      paper: true,
      state: "FILLED",
      createdAt: now,
      updatedAt: now,
    });
    return state;
  });

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 6000,
      qty: 1,
    },
    {
      aiSelected: true,
    },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "AI_MAX_ORDERS_PER_WINDOW"), true);
});

test("risk engine applies ai total exposure cap for auto-symbol buy orders", async () => {
  const { config, store } = await createTempStore();
  config.trading.aiMaxTotalExposureKrw = 70000;

  await store.update((state) => {
    const now = new Date().toISOString();
    state.balancesSnapshot.push({
      id: "balance-1",
      capturedAt: now,
      source: "test",
      items: [
        {
          currency: "USDT",
          unitCurrency: "KRW",
          balance: 30,
          locked: 0,
          avgBuyPrice: 1000,
        },
      ],
    });
    state.orders.push({
      id: "open-buy-1",
      symbol: "BTC_KRW",
      side: "buy",
      type: "limit",
      price: 40000,
      qty: 1,
      remainingQty: 1,
      filledQty: 0,
      paper: false,
      state: "ACCEPTED",
      createdAt: now,
      updatedAt: now,
    });
    return state;
  });

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 10000,
      qty: 1,
    },
    {
      aiSelected: true,
    },
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "AI_MAX_TOTAL_EXPOSURE_KRW"), true);
});

test("risk engine does not apply ai hard caps to non-auto-symbol orders", async () => {
  const { config, store } = await createTempStore();
  config.trading.aiMaxOrderNotionalKrw = 3000;

  const risk = new RiskEngine(config, store);
  const result = risk.evaluateOrder(
    {
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 6000,
      qty: 1,
    },
    {
      aiSelected: false,
    },
  );

  assert.equal(result.allowed, true);
});
