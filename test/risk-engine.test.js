import test from "node:test";
import assert from "node:assert/strict";
import { TraditionalRiskEngine } from "../src/engine/risk-engine.js";

const config = {
  risk: {
    minOrderNotionalKrw: 5000,
    maxOrderNotionalKrw: 300000,
    maxOpenOrders: 2,
    maxExposureKrw: 100000,
    maxDailyLossKrw: 20000,
  },
};

test("risk engine rejects below min notional", () => {
  const engine = new TraditionalRiskEngine(config);
  const result = engine.evaluate({
    amountKrw: 1000,
    side: "buy",
    openOrdersCount: 0,
    exposureKrw: 0,
    dailyPnlKrw: 0,
    chanceMinTotalKrw: 5000,
    killSwitch: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "MIN_ORDER_NOTIONAL_KRW"), true);
});

test("risk engine rejects buy when available cash is insufficient", () => {
  const engine = new TraditionalRiskEngine(config);
  const result = engine.evaluate({
    amountKrw: 30000,
    side: "buy",
    openOrdersCount: 0,
    exposureKrw: 0,
    dailyPnlKrw: 0,
    chanceMinTotalKrw: 5000,
    availableCashKrw: 10000,
    killSwitch: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "INSUFFICIENT_CASH"), true);
});

test("risk engine rejects by daily loss and exposure", () => {
  const engine = new TraditionalRiskEngine(config);
  const result = engine.evaluate({
    amountKrw: 50000,
    side: "buy",
    openOrdersCount: 1,
    exposureKrw: 80000,
    dailyPnlKrw: -25000,
    chanceMinTotalKrw: 5000,
    killSwitch: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "MAX_DAILY_LOSS_KRW"), true);
  assert.equal(result.reasons.some((r) => r.rule === "MAX_EXPOSURE_KRW"), true);
});

test("risk engine rejects sell when holdings are insufficient", () => {
  const engine = new TraditionalRiskEngine(config);
  const result = engine.evaluate({
    amountKrw: 20000,
    side: "sell",
    openOrdersCount: 0,
    exposureKrw: 0,
    dailyPnlKrw: 0,
    chanceMinTotalKrw: 5000,
    holdingNotionalKrw: 10000,
    killSwitch: false,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reasons.some((r) => r.rule === "SELL_EXCEEDS_HOLDING"), true);
});
