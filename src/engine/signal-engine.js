function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPositiveNumber(value, fallback) {
  const parsed = asNumber(value);
  if (parsed === null || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

  const normalized = candles
    .map((candle) => {
      const directTs = asNumber(candle.timestamp);
      const parsedTs = Date.parse(candle.candleTimeKst || candle.candleTimeUtc || "");
      const fallbackTs = Number.isFinite(parsedTs) ? parsedTs : 0;
      return {
        timestamp: directTs !== null ? directTs : fallbackTs,
        high: asNumber(candle.high),
        low: asNumber(candle.low),
        close: asNumber(candle.close),
      };
    })
    .filter((row) => row.high !== null && row.low !== null && row.close !== null);

  normalized.sort((a, b) => a.timestamp - b.timestamp);
  return normalized;
}

export class BreakoutSignalEngine {
  constructor(config) {
    this.lookback = Math.max(2, Number(config?.strategy?.breakoutLookback || 20));
    this.bufferBps = Math.max(0, Number(config?.strategy?.breakoutBufferBps || 0));
  }

  evaluate(candles = []) {
    const rows = normalizeCandles(candles);
    const required = this.lookback + 1;
    if (rows.length < required) {
      return {
        action: "HOLD",
        reason: "insufficient_candles",
        metrics: {
          required,
          received: rows.length,
        },
      };
    }

    const recent = rows.slice(-required);
    const current = recent[recent.length - 1];
    const history = recent.slice(0, -1);
    const highest = Math.max(...history.map((row) => row.high));
    const lowest = Math.min(...history.map((row) => row.low));
    const buffer = this.bufferBps / 10_000;

    const breakoutUp = current.close > highest * (1 + buffer);
    const breakoutDown = current.close < lowest * (1 - buffer);

    if (breakoutUp) {
      return {
        action: "BUY",
        reason: "breakout_up",
        metrics: {
          currentClose: current.close,
          highest,
          lowest,
          lookback: this.lookback,
          bufferBps: this.bufferBps,
        },
      };
    }

    if (breakoutDown) {
      return {
        action: "SELL",
        reason: "breakout_down",
        metrics: {
          currentClose: current.close,
          highest,
          lowest,
          lookback: this.lookback,
          bufferBps: this.bufferBps,
        },
      };
    }

    return {
      action: "HOLD",
      reason: "no_breakout",
      metrics: {
        currentClose: current.close,
        highest,
        lowest,
        lookback: this.lookback,
        bufferBps: this.bufferBps,
      },
    };
  }
}

export class RiskManagedMomentumSignalEngine {
  constructor(config) {
    this.momentumLookback = Math.max(2, Number(config?.strategy?.momentumLookback || 48));
    this.volatilityLookback = Math.max(5, Number(config?.strategy?.volatilityLookback || 96));
    this.entryBps = Math.max(0, Number(config?.strategy?.momentumEntryBps || 20));
    this.exitBps = Math.max(0, Number(config?.strategy?.momentumExitBps || this.entryBps / 2));
    this.targetVolatilityPct = asPositiveNumber(config?.strategy?.targetVolatilityPct, 0.35);
    this.minMultiplier = asPositiveNumber(config?.strategy?.riskManagedMinMultiplier, 0.4);
    this.maxMultiplier = asPositiveNumber(config?.strategy?.riskManagedMaxMultiplier, 1.8);
  }

  evaluate(candles = []) {
    const rows = normalizeCandles(candles);
    const required = Math.max(this.momentumLookback + 1, this.volatilityLookback + 1);
    if (rows.length < required) {
      return {
        action: "HOLD",
        reason: "insufficient_candles",
        metrics: {
          required,
          received: rows.length,
        },
      };
    }

    const closes = rows.map((row) => row.close);
    const currentClose = closes.at(-1);
    const momentumRef = closes.at(-(this.momentumLookback + 1));
    if (!Number.isFinite(currentClose) || !Number.isFinite(momentumRef) || momentumRef <= 0) {
      return {
        action: "HOLD",
        reason: "invalid_prices",
        metrics: {
          currentClose,
          momentumRef,
        },
      };
    }

    const momentumReturn = currentClose / momentumRef - 1;
    const returns = [];
    const startIdx = Math.max(1, closes.length - this.volatilityLookback);
    for (let i = startIdx; i < closes.length; i += 1) {
      const prev = closes[i - 1];
      const curr = closes[i];
      if (Number.isFinite(prev) && prev > 0 && Number.isFinite(curr)) {
        returns.push(curr / prev - 1);
      }
    }

    const realizedVol = stddev(returns);
    const targetVol = this.targetVolatilityPct / 100;
    const rawMultiplier = realizedVol > 0 ? targetVol / realizedVol : this.maxMultiplier;
    const riskMultiplier = clamp(rawMultiplier, this.minMultiplier, this.maxMultiplier);

    const entryThreshold = this.entryBps / 10_000;
    const exitThreshold = this.exitBps / 10_000;

    let action = "HOLD";
    let reason = "flat_momentum";
    if (momentumReturn >= entryThreshold) {
      action = "BUY";
      reason = "momentum_up";
    } else if (momentumReturn <= -exitThreshold) {
      action = "SELL";
      reason = "momentum_down";
    }

    return {
      action,
      reason,
      metrics: {
        currentClose,
        momentumLookback: this.momentumLookback,
        volatilityLookback: this.volatilityLookback,
        momentumReturn,
        momentumBps: momentumReturn * 10_000,
        realizedVolPct: realizedVol * 100,
        targetVolatilityPct: this.targetVolatilityPct,
        riskMultiplier,
      },
    };
  }
}

export function createSignalEngine(config) {
  const strategyName = String(config?.strategy?.name || "risk_managed_momentum").trim().toLowerCase();
  if (strategyName === "breakout") {
    return new BreakoutSignalEngine(config);
  }
  return new RiskManagedMomentumSignalEngine(config);
}
