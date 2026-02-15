import { normalizeSymbol } from "../config/defaults.js";
import { RiskManagedMomentumSignalEngine } from "./signal-engine.js";

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stddev(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function normalizeCandles(candles = []) {
  if (!Array.isArray(candles)) {
    return [];
  }
  const rows = candles
    .map((row, index) => {
      const tsDirect = asNumber(row?.timestamp, null);
      const tsUtc = Date.parse(row?.candleTimeUtc || "");
      const tsKst = Date.parse(row?.candleTimeKst || "");
      const timestamp = tsDirect ?? (Number.isFinite(tsUtc) ? tsUtc : Number.isFinite(tsKst) ? tsKst : index + 1);
      const close = asNumber(row?.close, null);
      return {
        timestamp,
        close,
      };
    })
    .filter((row) => row.close !== null && row.close > 0);

  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}

function parseIntervalMinutes(interval) {
  const token = String(interval || "15m").trim().toLowerCase();
  if (token === "day") {
    return 1440;
  }
  if (token === "week") {
    return 7 * 1440;
  }
  if (token === "month") {
    return 30 * 1440;
  }
  const match = token.match(/^(\d+)m$/);
  if (match) {
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : 15;
  }
  return 15;
}

function maxDrawdownPct(equityCurve = []) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return 0;
  }
  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity;
    }
    if (peak > 0) {
      const drawdown = (peak - equity) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }
  return maxDrawdown * 100;
}

function buildMomentumGrid(config = {}) {
  const momentumLookbacks = Array.isArray(config.momentumLookbacks) && config.momentumLookbacks.length > 0
    ? config.momentumLookbacks
    : [24, 36, 48, 72];
  const volatilityLookbacks = Array.isArray(config.volatilityLookbacks) && config.volatilityLookbacks.length > 0
    ? config.volatilityLookbacks
    : [72, 96, 120, 144];
  const entryBpsCandidates = Array.isArray(config.entryBpsCandidates) && config.entryBpsCandidates.length > 0
    ? config.entryBpsCandidates
    : [10, 16, 24, 32];
  const exitBpsCandidates = Array.isArray(config.exitBpsCandidates) && config.exitBpsCandidates.length > 0
    ? config.exitBpsCandidates
    : [6, 10, 14, 20];
  const targetVolatilityPctCandidates =
    Array.isArray(config.targetVolatilityPctCandidates) && config.targetVolatilityPctCandidates.length > 0
      ? config.targetVolatilityPctCandidates
      : [0.35, 0.5];
  const rmMinMultiplierCandidates =
    Array.isArray(config.rmMinMultiplierCandidates) && config.rmMinMultiplierCandidates.length > 0
      ? config.rmMinMultiplierCandidates
      : [0.4];
  const rmMaxMultiplierCandidates =
    Array.isArray(config.rmMaxMultiplierCandidates) && config.rmMaxMultiplierCandidates.length > 0
      ? config.rmMaxMultiplierCandidates
      : [1.6, 1.8];

  const grid = [];
  for (const momentumLookback of momentumLookbacks) {
    for (const volatilityLookback of volatilityLookbacks) {
      if (volatilityLookback <= momentumLookback) {
        continue;
      }
      for (const entryBps of entryBpsCandidates) {
        for (const exitBps of exitBpsCandidates) {
          if (exitBps > entryBps * 1.25) {
            continue;
          }
          for (const targetVolatilityPct of targetVolatilityPctCandidates) {
            for (const riskManagedMinMultiplier of rmMinMultiplierCandidates) {
              for (const riskManagedMaxMultiplier of rmMaxMultiplierCandidates) {
                if (riskManagedMaxMultiplier < riskManagedMinMultiplier) {
                  continue;
                }
                grid.push({
                  momentumLookback,
                  volatilityLookback,
                  momentumEntryBps: entryBps,
                  momentumExitBps: exitBps,
                  targetVolatilityPct,
                  riskManagedMinMultiplier,
                  riskManagedMaxMultiplier,
                });
              }
            }
          }
        }
      }
    }
  }
  return grid;
}

function scoreCandidate(metrics) {
  const totalReturnPct = asNumber(metrics.totalReturnPct, 0) ?? 0;
  const maxDdPct = asNumber(metrics.maxDrawdownPct, 0) ?? 0;
  const sharpe = asNumber(metrics.sharpe, 0) ?? 0;
  const profitFactor = Math.min(5, Math.max(0, asNumber(metrics.profitFactor, 0) ?? 0));
  const winRatePct = asNumber(metrics.winRatePct, 0) ?? 0;
  const tradeCount = asNumber(metrics.tradeCount, 0) ?? 0;

  // Return-first with explicit penalties for drawdown and low activity.
  const inactivityPenalty = tradeCount < 3 ? (3 - tradeCount) * 5 : 0;
  return totalReturnPct * 1.3 + sharpe * 2.5 + profitFactor * 2 + winRatePct * 0.08 - maxDdPct * 1.2 - inactivityPenalty;
}

function safetyCheck(metrics, constraints = {}) {
  const maxDrawdownPctLimit = asNumber(constraints.maxDrawdownPctLimit, 12) ?? 12;
  const minTrades = asNumber(constraints.minTrades, 4) ?? 4;
  const minWinRatePct = asNumber(constraints.minWinRatePct, 45) ?? 45;
  const minProfitFactor = asNumber(constraints.minProfitFactor, 1.05) ?? 1.05;
  const minReturnPct = asNumber(constraints.minReturnPct, 0) ?? 0;

  const checks = {
    maxDrawdown: (asNumber(metrics.maxDrawdownPct, 9999) ?? 9999) <= maxDrawdownPctLimit,
    minTrades: (asNumber(metrics.tradeCount, 0) ?? 0) >= minTrades,
    minWinRate: (asNumber(metrics.winRatePct, 0) ?? 0) >= minWinRatePct,
    minProfitFactor: (asNumber(metrics.profitFactor, 0) ?? 0) >= minProfitFactor,
    minReturn: (asNumber(metrics.totalReturnPct, -9999) ?? -9999) >= minReturnPct,
  };

  const safe = Object.values(checks).every(Boolean);
  return { safe, checks };
}

export function simulateRiskManagedMomentum({
  candles = [],
  strategy = {},
  interval = "15m",
  initialCashKrw = 1_000_000,
  baseOrderAmountKrw = 5_000,
  minOrderNotionalKrw = 5_000,
  feeBps = 5,
  autoSellEnabled = true,
} = {}) {
  const rows = normalizeCandles(candles);
  if (rows.length < 30) {
    return {
      ok: false,
      error: "insufficient_candles",
      metrics: null,
    };
  }

  const feeRate = Math.max(0, (asNumber(feeBps, 0) ?? 0) / 10_000);
  const engine = new RiskManagedMomentumSignalEngine({
    strategy: {
      ...strategy,
    },
  });

  let cash = Math.max(1, asNumber(initialCashKrw, 1_000_000) ?? 1_000_000);
  let qty = 0;
  let avgCost = 0;
  let turnoverKrw = 0;
  let buyCount = 0;
  let sellCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const equityCurve = [];
  let maxExposureKrw = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index];
    const partial = rows.slice(0, index + 1).map((row) => ({
      timestamp: row.timestamp,
      high: row.close,
      low: row.close,
      close: row.close,
    }));
    const signal = engine.evaluate(partial);

    const riskMultiplier = asNumber(signal?.metrics?.riskMultiplier, 1) ?? 1;
    const normalizedRiskMultiplier = clamp(riskMultiplier, 0.2, 3);
    const desiredOrderAmount = Math.max(1, Math.round((asNumber(baseOrderAmountKrw, 5_000) ?? 5_000) * normalizedRiskMultiplier));

    if (signal.action === "BUY") {
      let spend = Math.min(desiredOrderAmount, cash);
      if (spend >= minOrderNotionalKrw) {
        const grossQty = spend / current.close;
        const netQty = grossQty * (1 - feeRate);
        if (netQty > 0) {
          const totalCostBefore = avgCost * qty;
          qty += netQty;
          avgCost = qty > 0 ? (totalCostBefore + spend) / qty : 0;
          cash = Math.max(0, cash - spend);
          turnoverKrw += spend;
          buyCount += 1;
        }
      }
    } else if (autoSellEnabled && signal.action === "SELL" && qty > 0) {
      const holdingNotional = qty * current.close;
      let sellNotional = Math.min(desiredOrderAmount, holdingNotional);
      if (sellNotional >= minOrderNotionalKrw) {
        let sellQty = sellNotional / current.close;
        if (sellQty > qty) {
          sellQty = qty;
          sellNotional = qty * current.close;
        }
        if (sellQty > 0) {
          const proceeds = sellNotional * (1 - feeRate);
          const costBasis = avgCost * sellQty;
          const realized = proceeds - costBasis;
          if (realized >= 0) {
            grossProfit += realized;
            winCount += 1;
          } else {
            grossLoss += realized;
            lossCount += 1;
          }
          qty = Math.max(0, qty - sellQty);
          if (qty === 0) {
            avgCost = 0;
          }
          cash += proceeds;
          turnoverKrw += sellNotional;
          sellCount += 1;
        }
      }
    }

    const exposure = qty * current.close;
    if (exposure > maxExposureKrw) {
      maxExposureKrw = exposure;
    }
    const equity = cash + exposure;
    equityCurve.push(equity);
  }

  const lastPrice = rows.at(-1)?.close ?? 0;
  const finalEquity = cash + qty * lastPrice * (1 - feeRate);
  if (equityCurve.length > 0) {
    equityCurve[equityCurve.length - 1] = finalEquity;
  }

  const periodicReturns = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1];
    const curr = equityCurve[i];
    if (prev > 0 && curr > 0) {
      periodicReturns.push(curr / prev - 1);
    }
  }
  const retMean = periodicReturns.length > 0
    ? periodicReturns.reduce((sum, value) => sum + value, 0) / periodicReturns.length
    : 0;
  const retStd = stddev(periodicReturns);
  const intervalMinutes = parseIntervalMinutes(interval);
  const periodsPerYear = Math.max(1, Math.floor((365 * 24 * 60) / intervalMinutes));
  const sharpe = retStd > 0 ? (retMean / retStd) * Math.sqrt(periodsPerYear) : 0;
  const grossLossAbs = Math.abs(grossLoss);
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? 99 : 1;

  const metrics = {
    initialCashKrw: asNumber(initialCashKrw, 1_000_000) ?? 1_000_000,
    finalEquityKrw: finalEquity,
    totalReturnPct: ((finalEquity / (asNumber(initialCashKrw, 1_000_000) ?? 1_000_000)) - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    sharpe,
    volatilityPct: retStd * 100,
    turnoverKrw,
    tradeCount: buyCount + sellCount,
    buyCount,
    sellCount,
    winRatePct: winCount + lossCount > 0 ? (winCount / (winCount + lossCount)) * 100 : 0,
    profitFactor,
    grossProfitKrw: grossProfit,
    grossLossKrw: grossLoss,
    maxExposureKrw,
    openQty: qty,
    lastPrice,
  };

  return {
    ok: true,
    metrics,
  };
}

export function optimizeRiskManagedMomentum({
  candlesBySymbol = {},
  strategyBase = {},
  constraints = {},
  simulation = {},
  gridConfig = {},
} = {}) {
  const grid = buildMomentumGrid(gridConfig);
  const ranked = [];
  const symbols = Object.keys(candlesBySymbol).map((item) => normalizeSymbol(item));

  for (const symbol of symbols) {
    const candles = normalizeCandles(candlesBySymbol[symbol] || []);
    if (candles.length < 30) {
      continue;
    }

    for (const candidate of grid) {
      const strategy = {
        name: "risk_managed_momentum",
        ...strategyBase,
        ...candidate,
      };

      const simulationResult = simulateRiskManagedMomentum({
        candles,
        strategy,
        interval: simulation.interval,
        initialCashKrw: simulation.initialCashKrw,
        baseOrderAmountKrw: simulation.baseOrderAmountKrw,
        minOrderNotionalKrw: simulation.minOrderNotionalKrw,
        feeBps: simulation.feeBps,
        autoSellEnabled: simulation.autoSellEnabled,
      });
      if (!simulationResult.ok) {
        continue;
      }

      const safety = safetyCheck(simulationResult.metrics, constraints);
      const score = scoreCandidate(simulationResult.metrics);
      ranked.push({
        symbol,
        strategy,
        metrics: simulationResult.metrics,
        safety,
        score,
      });
    }
  }

  ranked.sort((a, b) => {
    if (a.safety.safe !== b.safety.safe) {
      return a.safety.safe ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (b.metrics.totalReturnPct || 0) - (a.metrics.totalReturnPct || 0);
  });

  const safeRanked = ranked.filter((row) => row.safety.safe);
  const best = safeRanked[0] || ranked[0] || null;

  return {
    best,
    ranked,
    safeRanked,
    evaluatedSymbols: symbols.length,
    evaluatedCandidates: ranked.length,
    gridSize: grid.length,
    constraints: {
      maxDrawdownPctLimit: asNumber(constraints.maxDrawdownPctLimit, 12) ?? 12,
      minTrades: asNumber(constraints.minTrades, 4) ?? 4,
      minWinRatePct: asNumber(constraints.minWinRatePct, 45) ?? 45,
      minProfitFactor: asNumber(constraints.minProfitFactor, 1.05) ?? 1.05,
      minReturnPct: asNumber(constraints.minReturnPct, 0) ?? 0,
    },
  };
}
