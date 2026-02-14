import { nowIso } from "../lib/time.js";
import { normalizeSymbol } from "../config/defaults.js";

const OPEN_ORDER_STATES = new Set(["NEW", "ACCEPTED", "PARTIAL", "CANCEL_REQUESTED", "UNKNOWN_SUBMIT"]);

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function notionalKrw(order) {
  const price = asNumber(order.price);
  const qty = asNumber(order.qty);
  return price * qty;
}

function remainingNotionalKrw(order) {
  const price = asNumber(order?.price, NaN);
  if (!Number.isFinite(price) || price <= 0) {
    return 0;
  }

  const remainingQty = asNumber(order?.remainingQty, NaN);
  const qty = Number.isFinite(remainingQty) && remainingQty > 0
    ? remainingQty
    : asNumber(order?.qty, 0);
  if (!Number.isFinite(qty) || qty <= 0) {
    return 0;
  }
  return price * qty;
}

function openBuyExposureKrw(state) {
  const orders = Array.isArray(state?.orders) ? state.orders : [];
  let total = 0;
  for (const order of orders) {
    if (!OPEN_ORDER_STATES.has(order?.state)) {
      continue;
    }
    if (String(order?.side || "").toLowerCase() !== "buy") {
      continue;
    }
    total += remainingNotionalKrw(order);
  }
  return total;
}

function latestBalanceItems(state) {
  const snapshots = Array.isArray(state?.balancesSnapshot) ? state.balancesSnapshot : [];
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  if (!latest || !Array.isArray(latest.items)) {
    return [];
  }
  return latest.items;
}

function holdingsExposureKrw(state) {
  const items = latestBalanceItems(state);
  let total = 0;
  for (const item of items) {
    const currency = String(item?.currency || "").toUpperCase();
    const unitCurrency = String(item?.unitCurrency || "KRW").toUpperCase();
    if (!currency || currency === "KRW" || unitCurrency !== "KRW") {
      continue;
    }

    const balance = asNumber(item?.balance, 0);
    const locked = asNumber(item?.locked, 0);
    const quantity = Math.max(balance + locked, 0);
    const avgBuyPrice = asNumber(item?.avgBuyPrice, NaN);
    if (!Number.isFinite(avgBuyPrice) || avgBuyPrice <= 0 || quantity <= 0) {
      continue;
    }

    total += quantity * avgBuyPrice;
  }
  return total;
}

function recentOrderCount(state, windowSec, nowTs = Date.now()) {
  if (!Number.isFinite(windowSec) || windowSec <= 0) {
    return 0;
  }

  const cutoff = nowTs - windowSec * 1000;
  const orders = Array.isArray(state?.orders) ? state.orders : [];
  let count = 0;
  for (const order of orders) {
    const ts = Date.parse(order?.createdAt || order?.updatedAt || "");
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (ts >= cutoff) {
      count += 1;
    }
  }
  return count;
}

export class RiskEngine {
  constructor(config, store) {
    this.config = config;
    this.store = store;
  }

  evaluateOrder(orderInput, context = {}) {
    const state = this.store.snapshot();
    const limits = this.config.trading;
    const openOrdersCount = this.store.getOpenOrders().length;
    const orderNotional = notionalKrw(orderInput);
    const symbol = normalizeSymbol(orderInput.symbol);
    const symbolMin = asNumber(limits.minOrderNotionalBySymbol?.[symbol], NaN);
    const baseMinOrderNotional = Number.isFinite(symbolMin) ? symbolMin : limits.minOrderNotionalKrw;
    const dynamicMinOrderNotional = asNumber(context.minOrderNotionalKrwOverride, NaN);
    const appliedMinOrderNotional = Number.isFinite(dynamicMinOrderNotional) && dynamicMinOrderNotional > 0
      ? Math.max(baseMinOrderNotional, dynamicMinOrderNotional)
      : baseMinOrderNotional;
    const side = String(orderInput.side || "").toLowerCase();
    const dailyRealizedPnl = asNumber(context.dailyRealizedPnlKrw, 0);
    const aiSelected = Boolean(context.aiSelected);
    const aiMaxOrderNotionalKrw = asNumber(limits.aiMaxOrderNotionalKrw, NaN);
    const aiMaxOrdersPerWindow = asNumber(limits.aiMaxOrdersPerWindow, NaN);
    const aiOrderCountWindowSec = asNumber(limits.aiOrderCountWindowSec, NaN);
    const aiMaxTotalExposureKrw = asNumber(limits.aiMaxTotalExposureKrw, NaN);
    const recentOrdersInWindow = recentOrderCount(state, aiOrderCountWindowSec);
    const projectedOrdersInWindow = recentOrdersInWindow + 1;
    const currentTotalExposureKrw = holdingsExposureKrw(state) + openBuyExposureKrw(state);
    const projectedTotalExposureKrw = currentTotalExposureKrw + (side === "buy" ? orderNotional : 0);
    const reasons = [];

    if (openOrdersCount >= limits.maxConcurrentOrders) {
      reasons.push({
        rule: "MAX_CONCURRENT_ORDERS",
        detail: `${openOrdersCount} >= ${limits.maxConcurrentOrders}`,
      });
    }

    if (orderNotional < appliedMinOrderNotional) {
      reasons.push({
        rule: "MIN_ORDER_NOTIONAL_KRW",
        detail: `${orderNotional} < ${appliedMinOrderNotional}`,
      });
    }

    if (orderNotional > limits.maxOrderNotionalKrw) {
      reasons.push({
        rule: "MAX_ORDER_NOTIONAL_KRW",
        detail: `${orderNotional} > ${limits.maxOrderNotionalKrw}`,
      });
    }

    if (Math.abs(dailyRealizedPnl) >= limits.dailyLossLimitKrw && dailyRealizedPnl < 0) {
      reasons.push({
        rule: "DAILY_LOSS_LIMIT_KRW",
        detail: `${dailyRealizedPnl} <= -${limits.dailyLossLimitKrw}`,
      });
    }

    if (aiSelected) {
      if (Number.isFinite(aiMaxOrderNotionalKrw) && aiMaxOrderNotionalKrw > 0 && orderNotional > aiMaxOrderNotionalKrw) {
        reasons.push({
          rule: "AI_MAX_ORDER_NOTIONAL_KRW",
          detail: `${orderNotional} > ${aiMaxOrderNotionalKrw}`,
        });
      }

      if (Number.isFinite(aiMaxOrdersPerWindow) && aiMaxOrdersPerWindow > 0 && projectedOrdersInWindow > aiMaxOrdersPerWindow) {
        reasons.push({
          rule: "AI_MAX_ORDERS_PER_WINDOW",
          detail: `${projectedOrdersInWindow} > ${aiMaxOrdersPerWindow} (window=${aiOrderCountWindowSec}s)`,
        });
      }

      if (side === "buy" && Number.isFinite(aiMaxTotalExposureKrw) && aiMaxTotalExposureKrw > 0 && projectedTotalExposureKrw > aiMaxTotalExposureKrw) {
        reasons.push({
          rule: "AI_MAX_TOTAL_EXPOSURE_KRW",
          detail: `${projectedTotalExposureKrw} > ${aiMaxTotalExposureKrw}`,
        });
      }
    }

    if (state.settings.killSwitch) {
      reasons.push({
        rule: "KILL_SWITCH_ACTIVE",
        detail: state.settings.killSwitchReason || "kill switch is active",
      });
    }

    const allowed = reasons.length === 0;
    return {
      allowed,
      reasons,
      checkedAt: nowIso(),
      metrics: {
        openOrdersCount,
        orderNotional,
        appliedMinOrderNotional,
        dynamicMinOrderNotional: Number.isFinite(dynamicMinOrderNotional) ? dynamicMinOrderNotional : null,
        dailyRealizedPnl,
        aiSelected,
        aiMaxOrderNotionalKrw: Number.isFinite(aiMaxOrderNotionalKrw) ? aiMaxOrderNotionalKrw : null,
        aiMaxOrdersPerWindow: Number.isFinite(aiMaxOrdersPerWindow) ? aiMaxOrdersPerWindow : null,
        aiOrderCountWindowSec: Number.isFinite(aiOrderCountWindowSec) ? aiOrderCountWindowSec : null,
        aiMaxTotalExposureKrw: Number.isFinite(aiMaxTotalExposureKrw) ? aiMaxTotalExposureKrw : null,
        recentOrdersInWindow,
        projectedOrdersInWindow,
        currentTotalExposureKrw,
        projectedTotalExposureKrw,
      },
    };
  }

  async recordRejection(orderInput, result) {
    await this.store.update((state) => {
      state.riskEvents.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        severity: "HIGH",
        ruleName: result.reasons.map((r) => r.rule).join(","),
        detail: {
          orderInput,
          reasons: result.reasons,
        },
        eventTs: nowIso(),
      });
      return state;
    });
  }
}
