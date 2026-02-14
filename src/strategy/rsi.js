function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeCloses(closes) {
  if (!Array.isArray(closes)) {
    return [];
  }
  return closes
    .map((item) => asNumber(item))
    .filter((item) => item !== null);
}

export function calculateRsi(closes, period = 14) {
  const normalizedPeriod = Number(period);
  if (!Number.isInteger(normalizedPeriod) || normalizedPeriod <= 0) {
    return null;
  }

  const values = sanitizeCloses(closes);
  if (values.length < normalizedPeriod + 1) {
    return null;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= normalizedPeriod; i += 1) {
    const change = values[i] - values[i - 1];
    if (change > 0) {
      avgGain += change;
    } else {
      avgLoss += Math.abs(change);
    }
  }
  avgGain /= normalizedPeriod;
  avgLoss /= normalizedPeriod;

  for (let i = normalizedPeriod + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (normalizedPeriod - 1) + gain) / normalizedPeriod;
    avgLoss = (avgLoss * (normalizedPeriod - 1) + loss) / normalizedPeriod;
  }

  if (avgLoss === 0 && avgGain === 0) {
    return 50;
  }
  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function evaluateRsiSignal({ rsi, oversold = 30, overbought = 70 } = {}) {
  const value = asNumber(rsi);
  const lower = asNumber(oversold);
  const upper = asNumber(overbought);
  if (value === null || lower === null || upper === null || lower >= upper) {
    return {
      signal: "HOLD",
      reason: "invalid_rsi_input",
    };
  }

  if (value <= lower) {
    return {
      signal: "BUY",
      reason: "rsi_oversold",
    };
  }
  if (value >= upper) {
    return {
      signal: "SELL",
      reason: "rsi_overbought",
    };
  }
  return {
    signal: "HOLD",
    reason: "rsi_neutral",
  };
}
