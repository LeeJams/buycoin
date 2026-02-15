import test from "node:test";
import assert from "node:assert/strict";
import { optimizeRiskManagedMomentum, simulateRiskManagedMomentum } from "../src/engine/strategy-optimizer.js";

function makeCandles({ startPrice = 1000, count = 160, slope = 1, noise = 0.3 }) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const wave = Math.sin(i / 7) * noise * startPrice * 0.01;
    price = Math.max(1, price + slope + wave);
    candles.push({
      timestamp: i + 1,
      close: price,
      high: price,
      low: price,
    });
  }
  return candles;
}

test("simulateRiskManagedMomentum returns metrics", () => {
  const result = simulateRiskManagedMomentum({
    candles: makeCandles({ startPrice: 1000, slope: 2 }),
    strategy: {
      momentumLookback: 24,
      volatilityLookback: 72,
      momentumEntryBps: 12,
      momentumExitBps: 8,
      targetVolatilityPct: 0.35,
      riskManagedMinMultiplier: 0.4,
      riskManagedMaxMultiplier: 1.8,
    },
    initialCashKrw: 1_000_000,
    baseOrderAmountKrw: 20_000,
    minOrderNotionalKrw: 5_000,
    feeBps: 5,
  });

  assert.equal(result.ok, true);
  assert.equal(Number.isFinite(result.metrics.totalReturnPct), true);
  assert.equal(result.metrics.tradeCount > 0, true);
});

test("optimizeRiskManagedMomentum ranks and selects best candidate", () => {
  const strong = makeCandles({ startPrice: 1000, slope: 3 });
  const weak = makeCandles({ startPrice: 1000, slope: -1.2, noise: 0.8 });
  const result = optimizeRiskManagedMomentum({
    candlesBySymbol: {
      BTC_KRW: strong,
      ETH_KRW: weak,
    },
    strategyBase: {
      autoSellEnabled: true,
      baseOrderAmountKrw: 10_000,
    },
    constraints: {
      maxDrawdownPctLimit: 30,
      minTrades: 2,
      minWinRatePct: 20,
      minProfitFactor: 0.8,
      minReturnPct: -100,
    },
    simulation: {
      interval: "15m",
      initialCashKrw: 1_000_000,
      baseOrderAmountKrw: 10_000,
      minOrderNotionalKrw: 5_000,
      feeBps: 5,
      autoSellEnabled: true,
    },
    gridConfig: {
      momentumLookbacks: [24, 36],
      volatilityLookbacks: [72],
      entryBpsCandidates: [10, 14],
      exitBpsCandidates: [6, 8],
      targetVolatilityPctCandidates: [0.35],
      rmMinMultiplierCandidates: [0.4],
      rmMaxMultiplierCandidates: [1.8],
    },
  });

  assert.equal(result.evaluatedSymbols, 2);
  assert.equal(result.evaluatedCandidates > 0, true);
  assert.equal(Boolean(result.best), true);
  assert.equal(result.ranked[0].score >= result.ranked.at(-1).score, true);
});
