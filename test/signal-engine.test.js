import test from "node:test";
import assert from "node:assert/strict";
import { BreakoutSignalEngine, RiskManagedMomentumSignalEngine } from "../src/engine/signal-engine.js";

const config = {
  strategy: {
    breakoutLookback: 3,
    breakoutBufferBps: 0,
  },
};

test("breakout engine returns BUY on upside breakout", () => {
  const engine = new BreakoutSignalEngine(config);
  const candles = [
    { timestamp: 1, high: 100, low: 90, close: 95 },
    { timestamp: 2, high: 101, low: 91, close: 96 },
    { timestamp: 3, high: 102, low: 92, close: 97 },
    { timestamp: 4, high: 103, low: 93, close: 104 },
  ];

  const signal = engine.evaluate(candles);
  assert.equal(signal.action, "BUY");
  assert.equal(signal.reason, "breakout_up");
});

test("breakout engine returns HOLD when data is insufficient", () => {
  const engine = new BreakoutSignalEngine(config);
  const signal = engine.evaluate([{ timestamp: 1, high: 1, low: 1, close: 1 }]);
  assert.equal(signal.action, "HOLD");
  assert.equal(signal.reason, "insufficient_candles");
});

test("risk-managed momentum returns BUY and risk multiplier in uptrend", () => {
  const engine = new RiskManagedMomentumSignalEngine({
    strategy: {
      momentumLookback: 3,
      volatilityLookback: 5,
      momentumEntryBps: 5,
      momentumExitBps: 5,
      targetVolatilityPct: 0.3,
      riskManagedMinMultiplier: 0.4,
      riskManagedMaxMultiplier: 1.8,
    },
  });

  const candles = [
    { timestamp: 1, high: 100, low: 100, close: 100 },
    { timestamp: 2, high: 101, low: 101, close: 101 },
    { timestamp: 3, high: 102, low: 102, close: 102 },
    { timestamp: 4, high: 103, low: 103, close: 103 },
    { timestamp: 5, high: 104, low: 104, close: 104 },
    { timestamp: 6, high: 106, low: 106, close: 106 },
  ];

  const signal = engine.evaluate(candles);
  assert.equal(signal.action, "BUY");
  assert.equal(signal.reason, "momentum_up");
  assert.equal(Number.isFinite(signal.metrics.riskMultiplier), true);
  assert.equal(signal.metrics.riskMultiplier > 0, true);
});
