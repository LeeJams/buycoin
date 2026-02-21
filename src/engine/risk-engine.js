function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class TraditionalRiskEngine {
  constructor(config) {
    this.config = config;
  }

  evaluate(input = {}) {
    const limits = this.config.risk;
    const amountKrw = asNumber(input.amountKrw, 0);
    const side = String(input.side || "buy").toLowerCase();
    const openOrdersCount = asNumber(input.openOrdersCount, 0);
    const openOrdersBySymbol = asNumber(input.openOrdersBySymbol, openOrdersCount);
    const exposureKrw = asNumber(input.exposureKrw, 0);
    const availableCashKrw = asNumber(input.availableCashKrw, 0);
    const dailyPnlKrw = asNumber(input.dailyPnlKrw, 0);
    const chanceMinTotalKrw = asNumber(input.chanceMinTotalKrw, 0);
    const holdingNotionalKrw = asNumber(input.holdingNotionalKrw, 0);

    const appliedMinNotional = Math.max(limits.minOrderNotionalKrw, chanceMinTotalKrw);
    const projectedExposureKrw = exposureKrw + (side === "buy" ? amountKrw : 0);
    const reasons = [];

    if (input.killSwitch) {
      reasons.push({
        rule: "KILL_SWITCH_ACTIVE",
        detail: "kill switch is enabled",
      });
    }

    if (openOrdersCount >= limits.maxOpenOrders) {
      reasons.push({
        rule: "MAX_OPEN_ORDERS",
        detail: `${openOrdersCount} >= ${limits.maxOpenOrders}`,
      });
    }

    if (openOrdersBySymbol >= limits.maxOpenOrdersPerSymbol) {
      reasons.push({
        rule: "MAX_OPEN_ORDERS_PER_SYMBOL",
        detail: `${openOrdersBySymbol} >= ${limits.maxOpenOrdersPerSymbol}`,
      });
    }

    if (amountKrw < appliedMinNotional) {
      reasons.push({
        rule: "MIN_ORDER_NOTIONAL_KRW",
        detail: `${amountKrw} < ${appliedMinNotional}`,
      });
    }

    if (amountKrw > limits.maxOrderNotionalKrw) {
      reasons.push({
        rule: "MAX_ORDER_NOTIONAL_KRW",
        detail: `${amountKrw} > ${limits.maxOrderNotionalKrw}`,
      });
    }

    if (side === "buy" && projectedExposureKrw > limits.maxExposureKrw) {
      reasons.push({
        rule: "MAX_EXPOSURE_KRW",
        detail: `${projectedExposureKrw} > ${limits.maxExposureKrw}`,
      });
    }

    if (side === "buy" && availableCashKrw + 1e-9 < amountKrw) {
      reasons.push({
        rule: "INSUFFICIENT_CASH",
        detail: `${availableCashKrw} < ${amountKrw}`,
      });
    }

    if (side === "sell" && holdingNotionalKrw <= 0) {
      reasons.push({
        rule: "NO_SELLABLE_HOLDING",
        detail: "no sellable holding for requested symbol",
      });
    }

    if (side === "sell" && amountKrw > holdingNotionalKrw) {
      reasons.push({
        rule: "SELL_EXCEEDS_HOLDING",
        detail: `${amountKrw} > ${holdingNotionalKrw}`,
      });
    }

    if (dailyPnlKrw <= -Math.abs(limits.maxDailyLossKrw)) {
      reasons.push({
        rule: "MAX_DAILY_LOSS_KRW",
        detail: `${dailyPnlKrw} <= -${Math.abs(limits.maxDailyLossKrw)}`,
      });
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      metrics: {
        amountKrw,
        appliedMinNotional,
        chanceMinTotalKrw,
        availableCashKrw,
        openOrdersCount,
        exposureKrw,
        projectedExposureKrw,
        openOrdersBySymbol,
        dailyPnlKrw,
        holdingNotionalKrw,
      },
    };
  }
}
