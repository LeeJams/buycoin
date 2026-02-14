import test from "node:test";
import assert from "node:assert/strict";
import { calculateRsi, evaluateRsiSignal } from "../src/strategy/rsi.js";

test("rsi calculator returns low RSI on consistent downtrend", () => {
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85];
  const rsi = calculateRsi(closes, 14);
  assert.equal(Number.isFinite(rsi), true);
  assert.equal(rsi < 30, true);
});

test("rsi calculator returns high RSI on consistent uptrend", () => {
  const closes = [85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100];
  const rsi = calculateRsi(closes, 14);
  assert.equal(Number.isFinite(rsi), true);
  assert.equal(rsi > 70, true);
});

test("rsi signal evaluator maps thresholds to BUY/SELL/HOLD", () => {
  const buy = evaluateRsiSignal({ rsi: 25, oversold: 30, overbought: 70 });
  const sell = evaluateRsiSignal({ rsi: 75, oversold: 30, overbought: 70 });
  const hold = evaluateRsiSignal({ rsi: 50, oversold: 30, overbought: 70 });
  assert.equal(buy.signal, "BUY");
  assert.equal(sell.signal, "SELL");
  assert.equal(hold.signal, "HOLD");
});
