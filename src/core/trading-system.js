import { EXIT_CODES } from "../config/exit-codes.js";
import { normalizeSymbol, toBithumbMarket } from "../config/defaults.js";
import { normalizeAccounts } from "./account-normalizer.js";
import { StateStore } from "./store.js";
import { MarketDataService } from "./market-data.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { BithumbPublicWsClient } from "../exchange/bithumb-public-ws.js";
import { createSignalEngine } from "../engine/signal-engine.js";
import { OverlayEngine } from "../engine/overlay-engine.js";
import { TraditionalRiskEngine } from "../engine/risk-engine.js";
import { ExecutionEngine } from "../engine/execution-engine.js";
import { clientOrderKey as buildClientOrderKey, uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

const ALLOWED_STRATEGY_NAMES = new Set(["risk_managed_momentum", "breakout"]);
const ALLOWED_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "60m",
  "240m",
  "day",
  "week",
  "month",
]);
const ALLOWED_DECISION_MODES = new Set(["rule", "filter", "override"]);

function asNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value, fallback) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function asPositiveNumber(value, fallback) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeStrategyName(value, fallback) {
  const token = String(value || fallback || "risk_managed_momentum")
    .trim()
    .toLowerCase();
  return ALLOWED_STRATEGY_NAMES.has(token) ? token : fallback;
}

function normalizeInterval(value, fallback) {
  const token = String(value || fallback || "15m").trim().toLowerCase();
  return ALLOWED_INTERVALS.has(token) ? token : fallback;
}

function normalizeDecisionMode(value, fallback = "filter") {
  const token = String(value || fallback || "filter")
    .trim()
    .toLowerCase();
  return ALLOWED_DECISION_MODES.has(token) ? token : fallback;
}

function normalizeForceAction(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (["buy", "bid"].includes(token)) {
    return "BUY";
  }
  if (["sell", "ask"].includes(token)) {
    return "SELL";
  }
  return null;
}

function normalizeExecutionPolicy(policy = {}, { autoSellEnabled = true } = {}) {
  const raw = policy && typeof policy === "object" ? policy : {};
  return {
    mode: normalizeDecisionMode(raw.mode, "filter"),
    allowBuy: raw.allowBuy === undefined ? true : Boolean(raw.allowBuy),
    allowSell: raw.allowSell === undefined ? Boolean(autoSellEnabled) : Boolean(raw.allowSell),
    forceAction: normalizeForceAction(raw.forceAction),
    forceAmountKrw: asPositiveNumber(raw.forceAmountKrw, null),
    forceOnce: raw.forceOnce === undefined ? true : Boolean(raw.forceOnce),
    note: raw.note ? String(raw.note) : null,
  };
}

function toDateByTimezone(timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMinTotal(chancePayload, side) {
  const sideKey = String(side || "buy").toLowerCase() === "sell" ? "ask" : "bid";
  const candidates = [
    chancePayload?.market?.[sideKey]?.min_total,
    chancePayload?.market?.[sideKey]?.minTotal,
    chancePayload?.[sideKey]?.min_total,
    chancePayload?.[sideKey]?.minTotal,
  ];

  for (const value of candidates) {
    const parsed = asNumber(value, null);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function normalizeSide(side) {
  const token = String(side || "").trim().toLowerCase();
  if (["buy", "bid"].includes(token)) {
    return "buy";
  }
  if (["sell", "ask"].includes(token)) {
    return "sell";
  }
  throw new Error(`Invalid side: ${side}`);
}

function normalizeType(type) {
  const token = String(type || "market").trim().toLowerCase();
  if (!["market", "limit"].includes(token)) {
    throw new Error(`Invalid type: ${type}`);
  }
  return token;
}

function computeQtyFromAmount(amountKrw, price) {
  if (!Number.isFinite(amountKrw) || amountKrw <= 0 || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  return Number((amountKrw / price).toFixed(8));
}

function floorToDecimals(value, decimals = 8) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const safeDecimals = Number.isFinite(decimals) ? Math.max(0, Math.floor(decimals)) : 8;
  const factor = 10 ** safeDecimals;
  return Math.floor(value * factor) / factor;
}

function trimTail(rows, limit) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const cap = asPositiveInt(limit, null);
  if (!Number.isFinite(cap) || cap <= 0) {
    return rows;
  }
  return rows.length > cap ? rows.slice(-cap) : rows;
}

function signalRiskMultiplier(signal, config) {
  const suggested = asNumber(signal?.metrics?.riskMultiplier, null);
  if (suggested === null || suggested <= 0) {
    return 1;
  }
  const min = asNumber(config?.strategy?.riskManagedMinMultiplier, 0.1);
  const max = asNumber(config?.strategy?.riskManagedMaxMultiplier, 3);
  return Math.max(min, Math.min(max, suggested));
}

function requiredCandleWindow(config) {
  const strategyName = String(config?.strategy?.name || "risk_managed_momentum").toLowerCase();
  if (strategyName === "breakout") {
    return Math.max(2, Math.floor(asNumber(config?.strategy?.breakoutLookback, 20)) + 1);
  }
  const momentum = Math.floor(asNumber(config?.strategy?.momentumLookback, 24));
  const volatility = Math.floor(asNumber(config?.strategy?.volatilityLookback, 72));
  return Math.max(2, momentum + 1, volatility + 1);
}

function calculateAccountMetrics(accounts = []) {
  let cashKrw = 0;
  let cashAvailableKrw = 0;
  let cashLockedKrw = 0;
  let exposureKrw = 0;
  const holdingsAvailable = {};
  const holdingsLocked = {};
  const holdingsAvgBuyPrice = {};

  const holdings = {};
  for (const account of accounts) {
    const currency = String(account.currency || "").toUpperCase();
    const unitCurrency = String(account.unitCurrency || "KRW").toUpperCase();
    const availableQty = Math.max(asNumber(account.balance, 0), 0);
    const lockedQty = Math.max(asNumber(account.locked, 0), 0);
    const quantity = availableQty + lockedQty;

    if (!currency || quantity <= 0) {
      continue;
    }

    if (currency === "KRW") {
      const locked = asNumber(account.locked, 0);
      cashAvailableKrw += asNumber(account.balance, 0);
      cashLockedKrw += Number.isFinite(locked) ? Math.max(0, locked) : 0;
      cashKrw += quantity;
      continue;
    }

    holdings[currency] = (holdings[currency] || 0) + quantity;
    holdingsAvailable[currency] = (holdingsAvailable[currency] || 0) + availableQty;
    holdingsLocked[currency] = (holdingsLocked[currency] || 0) + lockedQty;

    if (unitCurrency === "KRW") {
      const avgBuyPrice = asNumber(account.avgBuyPrice, null);
      if (avgBuyPrice !== null && avgBuyPrice > 0) {
        exposureKrw += quantity * avgBuyPrice;
        if (!Number.isFinite(holdingsAvgBuyPrice[currency])) {
          holdingsAvgBuyPrice[currency] = avgBuyPrice;
        }
      }
    }
  }

  return {
    cashKrw,
    cashAvailableKrw,
    cashLockedKrw,
    holdingsAvailable,
    holdingsLocked,
    holdingsAvgBuyPrice,
    exposureKrw,
    equityKrw: cashKrw + exposureKrw,
    holdings,
  };
}

function toEpochMs(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calculateExecutionKpiFromFills(fills = [], options = {}) {
  const fromMs = toEpochMs(options.sinceMs, 0);
  const untilMs = Number.isFinite(Number(options.untilMs))
    ? Math.max(fromMs, Math.floor(Number(options.untilMs)))
    : Date.now();
  const targetSymbol = options.symbol ? normalizeSymbol(options.symbol) : null;

  const selectedFills = Array.isArray(fills)
    ? fills.filter((fill) => {
      const filledAt = toEpochMs(fill?.eventTs, toEpochMs(fill?.createdAt, null));
      if (!Number.isFinite(filledAt) || filledAt < fromMs || filledAt > untilMs) {
        return false;
      }
      if (targetSymbol) {
        return normalizeSymbol(fill?.symbol || "") === targetSymbol;
      }
      return true;
    })
    : [];

  const summary = {
    fromMs,
    untilMs,
    fills: {
      count: 0,
      buyCount: 0,
      sellCount: 0,
      totalAmountKrw: 0,
      totalFeeKrw: 0,
      slippageSampleCount: 0,
      avgSignedSlippageBps: 0,
      avgAbsSlippageBps: 0,
      totalSignedSlippageBps: 0,
      totalAbsSlippageBps: 0,
    },
    realized: {
      tradeCount: 0,
      wins: 0,
      losses: 0,
      breakEven: 0,
      realizedPnlKrw: 0,
      winRatePct: 0,
      expectancyKrw: 0,
    },
    positions: {},
    symbol: targetSymbol || null,
    sampledAt: nowIso(),
  };

  const symbols = new Set();
  const positions = new Map();
  let totalSignedSlippage = 0;
  let totalAbsSlippage = 0;

  for (const fill of selectedFills) {
    const side = String(fill?.side || "").toLowerCase();
    const symbol = normalizeSymbol(fill?.symbol || "");
    const amountKrw = asNumber(fill?.amountKrw, 0);
    const qty = asNumber(fill?.qty, 0);
    const fee = asNumber(fill?.fee, 0);

    if (!Number.isFinite(amountKrw) || !Number.isFinite(qty) || amountKrw <= 0 || qty <= 0) {
      continue;
    }
    if (!symbols.has(symbol)) {
      symbols.add(symbol);
      positions.set(symbol, {
        qty: 0,
        costKrw: 0,
      });
    }

    summary.fills.count += 1;
    summary.fills.totalAmountKrw += amountKrw;
    summary.fills.totalFeeKrw += Number.isFinite(fee) ? fee : 0;

    const expectedPrice = asNumber(fill?.expectedPrice, null);
    const execPrice = asNumber(fill?.price, null);
    if (expectedPrice !== null && execPrice !== null && expectedPrice > 0) {
      const signed = side === "buy"
        ? (execPrice - expectedPrice) / expectedPrice * 10_000
        : (expectedPrice - execPrice) / expectedPrice * 10_000;
      if (Number.isFinite(signed)) {
        totalSignedSlippage += signed;
        totalAbsSlippage += Math.abs(signed);
        summary.fills.slippageSampleCount += 1;
      }
    }

    if (side === "buy") {
      summary.fills.buyCount += 1;
      const state = positions.get(symbol);
      if (state) {
        state.costKrw += amountKrw + (Number.isFinite(fee) ? fee : 0);
        state.qty += qty;
        positions.set(symbol, state);
      }
    } else if (side === "sell") {
      summary.fills.sellCount += 1;
      const state = positions.get(symbol);
      if (state && state.qty > 0) {
        const matchedQty = Math.min(qty, state.qty);
        const avgCost = state.qty > 0 ? state.costKrw / state.qty : 0;
        const grossExit = amountKrw;
        const netExit = grossExit - (Number.isFinite(fee) ? fee : 0);
        const realized = netExit - avgCost * matchedQty;
        summary.realized.tradeCount += 1;
        summary.realized.realizedPnlKrw += realized;
        if (realized > 0) {
          summary.realized.wins += 1;
        } else if (realized < 0) {
          summary.realized.losses += 1;
        } else {
          summary.realized.breakEven += 1;
        }

        state.qty = Math.max(0, state.qty - matchedQty);
        state.costKrw = Math.max(0, state.costKrw - avgCost * matchedQty);
        if (state.qty < 1e-12) {
          state.qty = 0;
          state.costKrw = 0;
        }
        positions.set(symbol, state);
      }
    }
  }

  const totalTrades = summary.realized.wins + summary.realized.losses + summary.realized.breakEven;
  summary.fills.avgSignedSlippageBps = summary.fills.slippageSampleCount > 0
    ? totalSignedSlippage / summary.fills.slippageSampleCount
    : 0;
  summary.fills.avgAbsSlippageBps = summary.fills.slippageSampleCount > 0
    ? totalAbsSlippage / summary.fills.slippageSampleCount
    : 0;
  summary.fills.totalSignedSlippageBps = totalSignedSlippage;
  summary.fills.totalAbsSlippageBps = totalAbsSlippage;
  summary.realized.winRatePct = totalTrades > 0 ? (summary.realized.wins / totalTrades) * 100 : 0;
  summary.realized.expectancyKrw = totalTrades > 0 ? summary.realized.realizedPnlKrw / totalTrades : 0;

  summary.positions = {};
  for (const [symbol, value] of positions.entries()) {
    summary.positions[symbol] = {
      qty: value.qty,
      costKrw: value.costKrw,
    };
  }

  return summary;
}

function toOrderListRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.orders)) {
    return payload.orders;
  }
  if (payload && typeof payload === "object") {
    return [payload];
  }
  return [];
}

function openOrderStates() {
  return new Set([
    "NEW",
    "PARTIAL",
    "WAIT",
    "WATCH",
    "ACCEPTED",
    "UNKNOWN_SUBMIT",
    "CANCEL_REQUESTED",
  ]);
}

function isTerminalOrderState(state) {
  return state === "DONE" || state === "CANCELED";
}

function asPositiveFiniteNumber(value, fallback = null) {
  const parsed = asNumber(value, fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOrderStateFromExchange(response = null) {
  const candidates = [
    response?.state,
    response?.status,
    response?.order_state,
    response?.orderState,
    response?.orderStatus,
    response?.order_status,
    response?.result?.state,
    response?.result?.status,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    const token = String(candidate).trim().toLowerCase();
    if (!token) {
      continue;
    }

    if (token.includes("cancel") && token.includes("request")) {
      return "CANCEL_REQUESTED";
    }
    if (token.includes("cancel")) {
      return "CANCELED";
    }
    if (["done", "filled", "complete", "completed", "closed", "trade"].includes(token)) {
      return "DONE";
    }
    if (["accept", "accepted", "accept_wait", "accepting"].includes(token)) {
      return "ACCEPTED";
    }
    if (["new", "wait", "watch", "open", "active", "submitted"].includes(token)) {
      return token.toUpperCase();
    }
    if (["partial", "partially_filled", "partial_filled", "partially_filled"].includes(token)) {
      return "PARTIAL";
    }
  }

  return null;
}

function toOrderPayload(response = null) {
  if (!response || typeof response !== "object") {
    return {};
  }
  if (Array.isArray(response)) {
    return response[0] || {};
  }
  if (response.order && typeof response.order === "object" && !Array.isArray(response.order)) {
    return response.order;
  }
  if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) {
    return response.data;
  }
  if (response.result && typeof response.result === "object" && !Array.isArray(response.result)) {
    return response.result;
  }
  return response;
}

function normalizeExchangeOrderId(response = null) {
  if (!response || typeof response !== "object") {
    return null;
  }
  const candidates = [
    response.uuid,
    response.order_id,
    response.orderId,
    response.id,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate).trim();
    }
  }
  return null;
}

function normalizeOrderFromExchange(response, existing = {}) {
  const payload = toOrderPayload(response);
  const state = normalizeOrderStateFromExchange(response) || normalizeOrderStateFromExchange(payload) || existing.state || "UNKNOWN_SUBMIT";
  const sideToken = String(payload.side || payload.order_side || existing.side || "").trim().toLowerCase();
  const side = sideToken === "ask" ? "sell" : sideToken === "bid" ? "buy" : existing.side || "buy";
  const typeToken = String(payload.ord_type || payload.orderType || payload.type || existing.type || "market").trim().toLowerCase();
  const type = typeToken === "price" || typeToken === "limit" ? "limit" : typeToken === "market" ? "market" : existing.type || "market";
  const rawAmount = asNumber(payload.price, existing.amountKrw);
  const rowPrice = asNumber(payload.price, existing.price);
  const rowQty = asNumber(payload.volume || payload.quantity, existing.qty);
  const filledQty = asPositiveFiniteNumber(payload.executed_volume, asPositiveFiniteNumber(payload.volume_traded, existing.filledQty));
  const remainingQty = asPositiveFiniteNumber(payload.remaining_volume, asPositiveFiniteNumber(payload.volume_remain, existing.remainingQty));
  const avgPrice = asPositiveFiniteNumber(
    payload.avg_price,
    asPositiveFiniteNumber(payload.average_price, asPositiveFiniteNumber(payload.trade_price, existing.filledPrice)),
  );
  const filledNotional = asPositiveFiniteNumber(payload.funds, asPositiveFiniteNumber(payload.executed_funds, existing.filledNotional));
  let filledPrice = asPositiveFiniteNumber(payload.avg_exec_price, avgPrice);
  if (!Number.isFinite(filledPrice) && Number.isFinite(filledNotional) && Number.isFinite(filledQty) && filledQty > 0) {
    filledPrice = filledNotional / filledQty;
  }
  const fee = asPositiveFiniteNumber(payload.paid_fee, asPositiveFiniteNumber(payload.fee, existing.fee));
  const exchangeOrderId = normalizeExchangeOrderId(payload);

  return {
    ...existing,
    id: existing.id,
    state,
    side,
    type,
    amountKrw: Number.isFinite(rawAmount) ? rawAmount : existing.amountKrw,
    price: Number.isFinite(rowPrice) ? rowPrice : existing.price,
    qty: Number.isFinite(rowQty) ? rowQty : existing.qty,
    filledQty: Number.isFinite(filledQty) ? filledQty : existing.filledQty,
    filledNotional: Number.isFinite(filledNotional) ? filledNotional : existing.filledNotional,
    filledPrice: Number.isFinite(filledPrice) ? filledPrice : existing.filledPrice,
    remainingQty: Number.isFinite(remainingQty) ? remainingQty : existing.remainingQty,
    exchangeOrderId: exchangeOrderId || existing.exchangeOrderId || null,
    fee,
    clientOrderKey: existing.clientOrderKey || payload.identifier || null,
    raw: response,
    updatedAt: nowIso(),
  };
}

function fillRowsFromOrder(orderRecord) {
  if (!orderRecord || !Number.isFinite(orderRecord.filledQty) || orderRecord.filledQty <= 0) {
    return [];
  }
  const amountKrw = Number.isFinite(orderRecord.filledNotional)
    ? orderRecord.filledNotional
    : Number.isFinite(orderRecord.filledQty) && Number.isFinite(orderRecord.filledPrice)
      ? orderRecord.filledQty * orderRecord.filledPrice
      : orderRecord.amountKrw;
  const idSource = orderRecord.id || orderRecord.exchangeOrderId || orderRecord.clientOrderKey || "unknown";
  const idPricePart = orderRecord.filledPrice || "market";
  const idQtyPart = orderRecord.filledQty || 0;
  const fillId = `fill-${idSource}-${idQtyPart}-${idPricePart}`;

  return [{
    id: fillId,
    orderId: orderRecord.id || null,
    exchangeOrderId: orderRecord.exchangeOrderId || null,
    symbol: orderRecord.symbol || null,
    side: orderRecord.side || null,
    type: orderRecord.type || null,
    qty: orderRecord.filledQty,
    amountKrw,
    price: orderRecord.filledPrice || null,
    fee: Number.isFinite(orderRecord.fee) ? orderRecord.fee : null,
    expectedPrice: Number.isFinite(orderRecord.expectedPrice) ? orderRecord.expectedPrice : null,
    createdAt: nowIso(),
    eventTs: Date.now(),
    source: "exchange_reconcile",
    raw: orderRecord.raw || null,
  }];
}

function parseIntervalMs(interval) {
  const token = String(interval || "60m").trim().toLowerCase();
  const minuteMap = { "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60, "240m": 240 };
  if (minuteMap[token] !== undefined) {
    return minuteMap[token] * 60_000;
  }
  if (token === "day") return 24 * 60 * 60_000;
  if (token === "week") return 7 * 24 * 60 * 60_000;
  if (token === "month") return 30 * 24 * 60 * 60_000;
  return 60_000;
}

class CandleAggregator {
  constructor(intervalMs, maxCompleted = 200) {
    this.intervalMs = Math.max(1, Math.floor(intervalMs || 60_000));
    this.maxCompleted = Math.max(1, Math.floor(maxCompleted));
    this.completedCandles = [];
    this.forming = null;
  }

  loadFromHistory(candles = []) {
    this.completedCandles = candles
      .filter((c) => c && Number.isFinite(asNumber(c.close)))
      .map((c) => {
        const close = asNumber(c.close);
        const open = asNumber(c.open ?? close);
        const high = asNumber(c.high ?? close);
        const low = asNumber(c.low ?? close);
        const timestamp = asNumber(c.timestamp);
        return {
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
          open: Number.isFinite(open) ? open : close,
          high: Number.isFinite(high) ? high : close,
          low: Number.isFinite(low) ? low : close,
          close,
        };
      });
    this.completedCandles.sort((a, b) => a.timestamp - b.timestamp);
    this.forming = null;
  }

  push(price, timestampMs) {
    const parsedPrice = asNumber(price);
    if (!Number.isFinite(parsedPrice)) {
      return;
    }

    const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
    const periodStart = Math.floor(ts / this.intervalMs) * this.intervalMs;

    if (!this.forming || this.forming.periodStart !== periodStart) {
      if (this.forming) {
        this.completedCandles.push({
          timestamp: this.forming.periodStart,
          open: this.forming.open,
          high: this.forming.high,
          low: this.forming.low,
          close: this.forming.close,
        });
        if (this.completedCandles.length > this.maxCompleted) {
          this.completedCandles = this.completedCandles.slice(-this.maxCompleted);
        }
      }
      this.forming = { periodStart, open: parsedPrice, high: parsedPrice, low: parsedPrice, close: parsedPrice };
    } else {
      this.forming.high = Math.max(this.forming.high, parsedPrice);
      this.forming.low = Math.min(this.forming.low, parsedPrice);
      this.forming.close = parsedPrice;
    }
  }

  allCandles(maxCount = 0) {
    const all = this.forming
      ? [
          ...this.completedCandles,
          {
            timestamp: this.forming.periodStart,
            open: this.forming.open,
            high: this.forming.high,
            low: this.forming.low,
            close: this.forming.close,
          },
        ]
      : [...this.completedCandles];

    if (maxCount > 0 && all.length > maxCount) {
      return all.slice(-maxCount);
    }
    return all;
  }
}

function normalizeRuntimeStrategy(input = {}, fallback = {}) {
  const base = fallback || {};
  const strategy = input && typeof input === "object" ? input : {};
  return {
    name: normalizeStrategyName(strategy.name, base.name || "risk_managed_momentum"),
    defaultSymbol: normalizeSymbol(strategy.defaultSymbol || base.defaultSymbol || "BTC_KRW"),
    candleInterval: normalizeInterval(strategy.candleInterval, base.candleInterval || "15m"),
    candleCount: asPositiveInt(strategy.candleCount, asPositiveInt(base.candleCount, 120)),
    breakoutLookback: asPositiveInt(strategy.breakoutLookback, asPositiveInt(base.breakoutLookback, 20)),
    breakoutBufferBps: asPositiveNumber(strategy.breakoutBufferBps, asPositiveNumber(base.breakoutBufferBps, 5)),
    momentumLookback: asPositiveInt(strategy.momentumLookback, asPositiveInt(base.momentumLookback, 24)),
    volatilityLookback: asPositiveInt(strategy.volatilityLookback, asPositiveInt(base.volatilityLookback, 72)),
    momentumEntryBps: asPositiveNumber(strategy.momentumEntryBps, asPositiveNumber(base.momentumEntryBps, 12)),
    momentumExitBps: asPositiveNumber(strategy.momentumExitBps, asPositiveNumber(base.momentumExitBps, 8)),
    targetVolatilityPct: asPositiveNumber(strategy.targetVolatilityPct, asPositiveNumber(base.targetVolatilityPct, 0.6)),
    riskManagedMinMultiplier: asPositiveNumber(
      strategy.riskManagedMinMultiplier,
      asPositiveNumber(base.riskManagedMinMultiplier, 0.6),
    ),
    riskManagedMaxMultiplier: asPositiveNumber(
      strategy.riskManagedMaxMultiplier,
      asPositiveNumber(base.riskManagedMaxMultiplier, 2.2),
    ),
    autoSellEnabled: strategy.autoSellEnabled === undefined
      ? base.autoSellEnabled !== false
      : Boolean(strategy.autoSellEnabled),
    sellAllOnExit: strategy.sellAllOnExit === undefined
      ? base.sellAllOnExit !== false
      : Boolean(strategy.sellAllOnExit),
    sellAllQtyPrecision: asPositiveInt(strategy.sellAllQtyPrecision, asPositiveInt(base.sellAllQtyPrecision, 8)),
    baseOrderAmountKrw: asPositiveNumber(strategy.baseOrderAmountKrw, asPositiveNumber(base.baseOrderAmountKrw, 5_000)),
  };
}

export class TradingSystem {
  constructor(config, deps = {}) {
    this.config = config;
    this.logger = deps.logger || {
      info() {},
      warn() {},
      error() {},
    };

    this.store = deps.store || new StateStore(config.runtime.stateFile, {
      lockStaleMs: config.runtime.stateLockStaleMs,
    });
    this.exchangeClient = deps.exchangeClient || new BithumbClient(config, this.logger);
    this.wsClient = deps.wsClient || new BithumbPublicWsClient(config, this.logger);
    this.marketData = deps.marketData || new MarketDataService(config, this.exchangeClient);
    this.signalEngine = deps.signalEngine || createSignalEngine(config);
    this.overlayEngine = deps.overlayEngine || new OverlayEngine(config);
    this.riskEngine = deps.riskEngine || new TraditionalRiskEngine(config);
    this.executionEngine = deps.executionEngine || new ExecutionEngine(this.exchangeClient);
    this.sleepFn = deps.sleepFn || sleep;
    this.orderSequence = Promise.resolve();
  }

  async withOrderSequence(task) {
    const next = this.orderSequence.then(task);
    this.orderSequence = next.catch(() => {});
    return next;
  }

  applyStateRetention(state) {
    const retention = this.config?.runtime?.retention || {};
    if (retention.keepLatestOnly) {
      const openStates = openOrderStates();
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const openOrders = orders.filter((order) => openStates.has(order?.state));
      const closedOrders = orders.filter((order) => !openStates.has(order?.state));
      const keepClosedOrders = trimTail(closedOrders, retention.closedOrders);

      const compactOrders = [];
      const seenOrderKey = new Set();
      for (const order of [...openOrders, ...keepClosedOrders]) {
        const key = order?.id || order?.exchangeOrderId || order?.clientOrderKey || null;
        if (key && seenOrderKey.has(key)) {
          continue;
        }
        if (key) {
          seenOrderKey.add(key);
        }
        compactOrders.push(order);
      }
      state.orders = compactOrders;

      const knownOrderIds = new Set(state.orders.map((order) => order?.id).filter(Boolean));
      const knownOrderKeys = new Set(state.orders.map((order) => order?.clientOrderKey).filter(Boolean));
      const orderEvents = Array.isArray(state.orderEvents) ? state.orderEvents : [];
      const orderEventTail = trimTail(orderEvents, retention.orderEvents);
      const filteredEvents = orderEventTail.filter((event) => {
        if (knownOrderIds.has(event?.orderId)) {
          return true;
        }
        const key = event?.payload?.clientOrderKey;
        return key ? knownOrderKeys.has(key) : false;
      });
      const dedupedEvents = [];
      const seenEventKeys = new Set();
      const pushEvent = (event) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const key = event.id
          ? `id:${event.id}`
          : `${event.orderId || ""}:${event.eventType || ""}:${event.eventTs || event.createdAt || ""}:${event.payload?.clientOrderKey || ""}`;
        if (seenEventKeys.has(key)) {
          return;
        }
        seenEventKeys.add(key);
        dedupedEvents.push(event);
      };
      for (const event of filteredEvents) {
        pushEvent(event);
      }
      for (const event of orderEventTail) {
        pushEvent(event);
      }
      state.orderEvents = trimTail(dedupedEvents, retention.orderEvents);

      const strategyRunsRetention = Number.isFinite(retention.keepLatestOnlyStrategyRuns)
        ? Math.max(1, Math.floor(retention.keepLatestOnlyStrategyRuns))
        : 1;
      const balancesSnapshotRetention = Number.isFinite(retention.keepLatestOnlyBalancesSnapshot)
        ? Math.max(1, Math.floor(retention.keepLatestOnlyBalancesSnapshot))
        : 1;
      const fillsRetention = Number.isFinite(retention.keepLatestOnlyFills)
        ? Math.max(1, Math.floor(retention.keepLatestOnlyFills))
        : Math.max(1, Math.floor(retention.fills || 0));
      const riskEventsRetention = Number.isFinite(retention.keepLatestOnlyRiskEvents)
        ? Math.max(1, Math.floor(retention.keepLatestOnlyRiskEvents))
        : 100;
      const systemHealthRetention = Number.isFinite(retention.keepLatestOnlySystemHealth)
        ? Math.max(1, Math.floor(retention.keepLatestOnlySystemHealth))
        : 100;
      const agentAuditRetention = Number.isFinite(retention.keepLatestOnlyAgentAudit)
        ? Math.max(1, Math.floor(retention.keepLatestOnlyAgentAudit))
        : 100;

      state.strategyRuns = trimTail(state.strategyRuns, strategyRunsRetention);
      state.balancesSnapshot = trimTail(state.balancesSnapshot, balancesSnapshotRetention);
      state.fills = trimTail(state.fills, fillsRetention);
      state.riskEvents = trimTail(state.riskEvents, riskEventsRetention);
      state.systemHealth = trimTail(state.systemHealth, systemHealthRetention);
      state.agentAudit = trimTail(state.agentAudit, agentAuditRetention);
      if (state.marketData && typeof state.marketData === "object") {
        state.marketData.ticks = [];
        state.marketData.candles = [];
      }
      return state;
    }

    state.orders = trimTail(state.orders, retention.orders);
    state.orderEvents = trimTail(state.orderEvents, retention.orderEvents);
    state.strategyRuns = trimTail(state.strategyRuns, retention.strategyRuns);
    state.balancesSnapshot = trimTail(state.balancesSnapshot, retention.balancesSnapshot);
    state.fills = trimTail(state.fills, retention.fills);
    return state;
  }

  async init() {
    await this.store.init();
    await this.store.update((state) => {
      if (typeof state.settings.killSwitch !== "boolean") {
        state.settings.killSwitch = false;
      }
      if (!state.system) {
        state.system = {};
      }
      if (!state.system.lastRun) {
        state.system.lastRun = null;
      }
      if (!state.settings.dailyPnlBaseline) {
        state.settings.dailyPnlBaseline = null;
      }
      return this.applyStateRetention(state);
    });
  }

  hasKeys() {
    return Boolean(this.config.exchange.accessKey && this.config.exchange.secretKey);
  }

  getOpenOrdersCount(symbol = null) {
    const state = this.store.snapshot();
    const openStates = openOrderStates();
    const nowMs = Date.now();
    const normalizedSymbol = symbol ? normalizeSymbol(symbol) : null;
    const unknownSubmitStaleMs = 30 * 60 * 1000; // 30 min — UNKNOWN_SUBMIT past this age no longer blocks new orders
    return state.orders.filter((order) => {
      if (!openStates.has(order.state)) return false;
      if (normalizedSymbol) {
        if (!order.symbol) {
          return false;
        }
        if (normalizeSymbol(order.symbol) !== normalizedSymbol) {
          return false;
        }
      }
      if (order.state === "UNKNOWN_SUBMIT") {
        const placedMs = Date.parse(order.placedAt || "");
        if (Number.isFinite(placedMs) && nowMs - placedMs > unknownSubmitStaleMs) {
          return false;
        }
      }
      return true;
    }).length;
  }

  async recordRiskEvent(event = {}) {
    await this.store.update((state) => {
      state.riskEvents.push({
        id: uuid(),
        at: nowIso(),
        ...event,
      });
      return this.applyStateRetention(state);
    });
  }

  async bumpRiskRejectStreak({ symbol = null, reasons = [], metrics = {} } = {}) {
    const nowMs = Date.now();
    const resetMs = Math.max(
      0,
      Math.floor(asNumber(this.config.risk.riskRejectResetSec, 300) * 1000),
    );
    let nextStreak = 1;

    const current = this.store.snapshot().settings?.riskReject || {};
    const lastUpdatedMs = Date.parse(current.updatedAt || "");
    const previousStreak = asNumber(current.streak, 0);
    if (Number.isFinite(lastUpdatedMs) && resetMs > 0 && nowMs - lastUpdatedMs <= resetMs) {
      nextStreak = Math.max(1, previousStreak + 1);
    }

    await this.store.update((state) => {
      state.settings.riskReject = {
        streak: nextStreak,
        lastSymbol: symbol,
        reasons,
        metrics,
        updatedAt: nowIso(),
      };
      return state;
    });

    return nextStreak;
  }

  async clearRiskRejectStreak() {
    await this.store.update((state) => {
      state.settings.riskReject = {
        streak: 0,
        updatedAt: nowIso(),
      };
      return state;
    });
  }

  async resolveProtectiveExit({ symbol, currentPrice }) {
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const [baseCurrency] = normalizedSymbol.split("_");
    const price = asNumber(currentPrice, null);

    if (!baseCurrency || price === null || price <= 0) {
      return null;
    }

    const accountContext = await this.loadAccountContext();
    const holdingQty = asNumber(accountContext.metrics.holdingsAvailable?.[baseCurrency], 0);
    if (!Number.isFinite(holdingQty) || holdingQty <= 0) {
      return null;
    }

    const avgBuyPrice = asNumber(accountContext.metrics.holdingsAvgBuyPrice?.[baseCurrency], null);
    if (avgBuyPrice === null || avgBuyPrice <= 0) {
      return null;
    }

    const pnlRatio = price / avgBuyPrice - 1;
    const stopLossPct = asNumber(this.config.risk.maxHoldingLossPct, 0);
    const takeProfitPct = asNumber(this.config.risk.maxHoldingTakeProfitPct, 0);

    if (Number.isFinite(stopLossPct) && stopLossPct > 0 && pnlRatio <= -Math.abs(stopLossPct) / 100) {
      return {
        shouldExit: true,
        action: "SELL",
        reason: "protective_stop_loss",
        pnlRatio,
        avgBuyPrice,
        currentPrice: price,
      };
    }

    if (Number.isFinite(takeProfitPct) && takeProfitPct > 0 && pnlRatio >= Math.abs(takeProfitPct) / 100) {
      return {
        shouldExit: true,
        action: "SELL",
        reason: "protective_take_profit",
        pnlRatio,
        avgBuyPrice,
        currentPrice: price,
      };
    }

    return null;
  }

  async status() {
    const state = this.store.snapshot();
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        now: nowIso(),
        mode: "live",
        killSwitch: Boolean(state.settings.killSwitch),
        killSwitchReason: state.settings.killSwitchReason || null,
        defaultSymbol: this.config.strategy.defaultSymbol,
        strategy: {
          name: this.config.strategy.name,
          interval: this.config.strategy.candleInterval,
          lookback: this.config.strategy.breakoutLookback,
          baseOrderAmountKrw: this.config.strategy.baseOrderAmountKrw,
          sellAllOnExit: this.config.strategy.sellAllOnExit !== false,
          sellAllQtyPrecision: this.config.strategy.sellAllQtyPrecision,
        },
        overlay: state.system?.overlayCache || null,
        dailyPnlBaseline: state.settings.dailyPnlBaseline || null,
        openOrders: this.getOpenOrdersCount(),
        executionKpi: state.system?.lastExecutionKpi || null,
        lastRun: state.system?.lastRun || null,
      },
    };
  }

  computeExecutionKpi(options = {}) {
    const state = this.store.snapshot();
    return calculateExecutionKpiFromFills(state.fills || [], {
      sinceMs: options.sinceMs,
      untilMs: options.untilMs,
      symbol: options.symbol,
    });
  }

  async recordExecutionKpi(kpi = null) {
    await this.store.update((state) => {
      if (!state.system) {
        state.system = {};
      }
      state.system.lastExecutionKpi = kpi;
      return state;
    });
  }

  async setKillSwitch(enabled, reason = null) {
    await this.store.update((state) => {
      state.settings.killSwitch = Boolean(enabled);
      state.settings.killSwitchAt = nowIso();
      state.settings.killSwitchReason = reason || null;
      return state;
    });

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        killSwitch: Boolean(enabled),
        reason: reason || null,
      },
    };
  }

  async applyStrategySettings(strategy = {}, source = "runtime") {
    const normalized = normalizeRuntimeStrategy(strategy, this.config.strategy);
    this.config.strategy = normalized;
    this.signalEngine = createSignalEngine(this.config);
    this.logger.info("strategy settings applied", {
      source,
      strategy: normalized.name,
      defaultSymbol: normalized.defaultSymbol,
      candleInterval: normalized.candleInterval,
      momentumLookback: normalized.momentumLookback,
      volatilityLookback: normalized.volatilityLookback,
      momentumEntryBps: normalized.momentumEntryBps,
      momentumExitBps: normalized.momentumExitBps,
      sellAllOnExit: normalized.sellAllOnExit,
      sellAllQtyPrecision: normalized.sellAllQtyPrecision,
    });
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: normalized,
    };
  }

  async fetchTicker(symbol) {
    try {
      const normalized = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
      const ticker = await this.marketData.getMarketTicker(normalized);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: ticker,
      };
    } catch (error) {
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
        },
      };
    }
  }

  async streamTicker({ symbol = null, durationSec = 30, maxEvents = 300 } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const eventLimit = Number.isFinite(Number(maxEvents)) ? Math.max(1, Math.floor(Number(maxEvents))) : 300;
    const durationMs = Number.isFinite(Number(durationSec)) ? Math.max(0, Math.floor(Number(durationSec)) * 1000) : 30_000;
    const startedAt = nowIso();

    const ticks = [];
    let streamError = null;
    let streamHandle = null;
    let timer = null;

    try {
      streamHandle = await this.wsClient.openTickerStream({
        symbols: [normalizedSymbol],
        onTicker: (tick) => {
          ticks.push(tick);
          if (ticks.length > eventLimit) {
            ticks.splice(0, ticks.length - eventLimit);
          }
          if (ticks.length >= eventLimit && streamHandle) {
            streamHandle.close();
          }
        },
        onError: (error) => {
          streamError = error;
          if (streamHandle) {
            streamHandle.close();
          }
        },
      });

      if (durationMs > 0) {
        timer = setTimeout(() => {
          if (streamHandle) {
            streamHandle.close();
          }
        }, durationMs);
      }

      await streamHandle.closed;
      if (timer) {
        clearTimeout(timer);
      }

      if (streamError) {
        return {
          ok: false,
          code: EXIT_CODES.EXCHANGE_RETRYABLE,
          error: {
            message: streamError.message || "Ticker stream failed",
          },
        };
      }

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          symbol: normalizedSymbol,
          market: toBithumbMarket(normalizedSymbol),
          startedAt,
          endedAt: nowIso(),
          count: ticks.length,
          ticks,
        },
      };
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
        },
      };
    }
  }

  async runStrategyRealtime({
    symbol = null,
    amount = null,
    durationSec = 300,
    cooldownSec = 30,
    dryRun = false,
    executionPolicy = null,
  } = {}) {
    const runId = uuid();
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const startedAt = nowIso();
    const windowSize = requiredCandleWindow(this.config);
    const cooldownMs = Math.max(0, Math.floor(Number(cooldownSec) * 1000));
    const durationMs = Number.isFinite(Number(durationSec)) ? Math.max(0, Math.floor(Number(durationSec)) * 1000) : 300_000;
    const autoSellEnabled = this.config.strategy.autoSellEnabled !== false;
    const aiPolicy = normalizeExecutionPolicy(executionPolicy, {
      autoSellEnabled,
    });

    await this.store.update((state) => {
      state.strategyRuns.push({
        id: runId,
        strategy: `${this.config.strategy.name}_realtime`,
        symbol: normalizedSymbol,
        startedAt,
        mode: "live",
        dryRun: Boolean(dryRun),
        status: "RUNNING",
      });
      return this.applyStateRetention(state);
    });

    const intervalMs = parseIntervalMs(this.config.strategy.candleInterval);
    const maxCandles = asPositiveInt(this.config.strategy.candleCount, 120);
    const aggregator = new CandleAggregator(intervalMs, maxCandles + 20);

    // Pre-load historical OHLCV candles to seed the aggregator before live ticks arrive.
    try {
      const candleRes = await this.marketData.getCandles({
        symbol: normalizedSymbol,
        interval: this.config.strategy.candleInterval,
        count: maxCandles,
      });
      if (candleRes?.candles?.length > 0) {
        aggregator.loadFromHistory(candleRes.candles);
      }
    } catch (err) {
      this.logger.warn("realtime: failed to pre-load historical candles", {
        symbol: normalizedSymbol,
        reason: err.message,
      });
    }

    const decisions = [];
    let tickCount = 0;
    let buySignals = 0;
    let sellSignals = 0;
    let attemptedOrders = 0;
    let successfulOrders = 0;
    let lastOrderAtMs = 0;
    let streamError = null;
    let streamHandle = null;
    let timer = null;
    let processing = Promise.resolve();
    let overrideActionConsumed = false;

    try {
      streamHandle = await this.wsClient.openTickerStream({
        symbols: [normalizedSymbol],
        onTicker: (tick) => {
          tickCount += 1;
          const tickTs = Number.isFinite(Number(tick.timestamp)) ? Number(tick.timestamp) : Date.now();
          aggregator.push(tick.tradePrice, tickTs);
          // Snapshot the candle state at the moment this tick arrived so the async
          // callback evaluates the signal with a consistent, point-in-time view even
          // if later ticks update the aggregator before the promise chain resolves.
          const candlesSnapshot = aggregator.allCandles(maxCandles + 10);

          processing = processing
            .then(async () => {
              if (candlesSnapshot.length < windowSize) {
                return;
              }

              const signal = this.signalEngine.evaluate(candlesSnapshot);
              if (signal.action === "BUY") {
                buySignals += 1;
              } else if (signal.action === "SELL") {
                sellSignals += 1;
              }

              const protectiveExit = await this.resolveProtectiveExit({
                symbol: normalizedSymbol,
                currentPrice: tick.tradePrice,
              });
              const forcedExit = protectiveExit?.shouldExit ? true : false;
              const protectiveReason = protectiveExit?.reason || null;

              let selectedAction = null;
              let selectedReason = forcedExit ? (protectiveReason || signal.reason) : signal.reason;
              let selectedSource = forcedExit ? "protective_exit" : "rule_signal";
              const canUseOverride =
                aiPolicy.mode === "override" &&
                aiPolicy.forceAction &&
                !(aiPolicy.forceOnce && overrideActionConsumed);

              if (forcedExit) {
                selectedAction = protectiveExit.action;
              } else if (canUseOverride) {
                selectedAction = aiPolicy.forceAction;
                selectedReason = aiPolicy.note || "ai_override";
                selectedSource = "ai_override";
              } else if (signal.action === "BUY") {
                if (aiPolicy.allowBuy) {
                  selectedAction = "BUY";
                } else {
                  selectedReason = "ai_filter_block_buy";
                }
              } else if (signal.action === "SELL") {
                if (!autoSellEnabled) {
                  selectedReason = "auto_sell_disabled";
                } else if (aiPolicy.allowSell) {
                  selectedAction = "SELL";
                } else {
                  selectedReason = "ai_filter_block_sell";
                }
              }

              if (!selectedAction) {
                return;
              }

              const nowMs = Date.now();
              if (cooldownMs > 0 && nowMs - lastOrderAtMs < cooldownMs) {
                decisions.push({
                  at: nowIso(),
                  price: tick.tradePrice,
                  signal: signal.action,
                  action: selectedAction,
                  actionSource: selectedSource,
                  side: selectedAction === "SELL" ? "sell" : "buy",
                  skipped: "cooldown",
                });
                if (decisions.length > 100) {
                  decisions.shift();
                }
                return;
              }

              const overlay = await this.resolveOverlay();
              const aiOverrideAmount =
                selectedSource === "ai_override" ? asPositiveNumber(aiPolicy.forceAmountKrw, null) : null;
              const baseAmount =
                aiOverrideAmount ?? asNumber(amount, null) ?? this.config.strategy.baseOrderAmountKrw;
              const signalMultiplier =
                selectedSource === "ai_override" ? 1 : signalRiskMultiplier(signal, this.config);
              const totalMultiplier =
                selectedSource === "ai_override" && aiOverrideAmount !== null
                  ? 1
                  : Math.max(0.01, overlay.multiplier * signalMultiplier);
              const adjustedAmount = Math.max(1, Math.round(baseAmount * totalMultiplier));
              const orderSide = selectedAction === "SELL" ? "sell" : "buy";
              let orderAmountKrw = adjustedAmount;
              let sellPlan = null;

              if (orderSide === "sell") {
                sellPlan = await this.resolveSellOrderAmount({
                  symbol: normalizedSymbol,
                  price: tick.tradePrice,
                  fallbackAmountKrw: adjustedAmount,
                });
                orderAmountKrw = asNumber(sellPlan.amountKrw, adjustedAmount);
                if (!Number.isFinite(orderAmountKrw) || orderAmountKrw <= 0) {
                  if (forcedExit) {
                    await this.recordRiskEvent({
                      type: "protective_exit",
                      source: "risk_exit_rule",
                      symbol: normalizedSymbol,
                      reason: protectiveReason,
                      pnlRatio: protectiveExit.pnlRatio,
                      avgBuyPrice: protectiveExit.avgBuyPrice,
                      currentPrice: protectiveExit.currentPrice,
                    });
                  }
                  decisions.push({
                    at: nowIso(),
                    price: tick.tradePrice,
                    signal: signal.action,
                    action: selectedAction,
                    actionSource: selectedSource,
                    side: orderSide,
                    skipped: "no_position",
                    sellPlan,
                  });
                  if (decisions.length > 100) {
                    decisions.shift();
                  }
                  return;
                }
              }

              attemptedOrders += 1;
              if (forcedExit) {
                await this.recordRiskEvent({
                  type: "protective_exit",
                  source: "risk_exit_rule",
                  symbol: normalizedSymbol,
                  reason: protectiveReason,
                  pnlRatio: protectiveExit.pnlRatio,
                  avgBuyPrice: protectiveExit.avgBuyPrice,
                  currentPrice: protectiveExit.currentPrice,
                });
              }

              const order = await this.placeOrder({
                symbol: normalizedSymbol,
                side: orderSide,
                type: "market",
                amount: orderAmountKrw,
                price: orderSide === "sell" ? tick.tradePrice : null,
                expectedPrice: tick.tradePrice,
                dryRun,
                reason: `strategy:${this.config.strategy.name}:realtime:${selectedReason}`,
              });
              if (!dryRun && selectedSource === "ai_override" && aiPolicy.forceOnce) {
                overrideActionConsumed = true;
              }

              if (order.ok) {
                successfulOrders += 1;
                lastOrderAtMs = nowMs;
              }

              decisions.push({
                at: nowIso(),
                price: tick.tradePrice,
                signal: signal.action,
                action: selectedAction,
                actionSource: selectedSource,
                actionReason: selectedReason,
                side: orderSide,
                amountBaseKrw: baseAmount,
                amountAdjustedKrw: adjustedAmount,
                amountSubmittedKrw: orderAmountKrw,
                overlayMultiplier: overlay.multiplier,
                signalMultiplier,
                totalMultiplier,
                sellPlan,
                protectiveExit: forcedExit ? protectiveExit : null,
                orderOk: order.ok,
                orderCode: order.code,
                error: order.ok ? null : order.error,
              });
              if (decisions.length > 100) {
                decisions.shift();
              }
            })
            .catch((error) => {
              streamError = error;
              if (streamHandle) {
                streamHandle.close();
              }
            });
        },
        onError: (error) => {
          streamError = error;
          if (streamHandle) {
            streamHandle.close();
          }
        },
      });

      if (durationMs > 0) {
        timer = setTimeout(() => {
          if (streamHandle) {
            streamHandle.close();
          }
        }, durationMs);
      }

      await streamHandle.closed;
      if (timer) {
        clearTimeout(timer);
      }
      await processing;

      if (streamError) {
      await this.finishRun(runId, "FAILED", {
        error: {
          message: streamError.message || "Realtime stream failed",
        },
      });
      await this.store.update((state) => {
        if (!state.system) {
          state.system = {};
        }
        state.system.lastRun = {
          runId,
          status: "FAILED",
          at: nowIso(),
          signal: "REALTIME",
          dryRun: Boolean(dryRun),
          symbol: normalizedSymbol,
        };
        return state;
      });
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: streamError.message || "Realtime stream failed",
          },
        };
      }

      const summary = {
        runId,
        symbol: normalizedSymbol,
        startedAt,
        endedAt: nowIso(),
        durationSec: durationMs > 0 ? Math.floor(durationMs / 1000) : 0,
        cooldownSec: Math.floor(cooldownMs / 1000),
        tickCount,
        buySignals,
        sellSignals,
        attemptedOrders,
        successfulOrders,
        dryRun: Boolean(dryRun),
        executionPolicy: aiPolicy,
        decisions,
      };

      await this.finishRun(runId, "COMPLETED", {
        result: summary,
      });
      await this.store.update((state) => {
        if (!state.system) {
          state.system = {};
        }
        state.system.lastRun = {
          runId,
          status: "COMPLETED",
          at: nowIso(),
          signal: "REALTIME",
          dryRun: Boolean(dryRun),
          symbol: normalizedSymbol,
        };
        return state;
      });

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: summary,
      };
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }
      await this.finishRun(runId, "FAILED", {
        error: {
          message: error.message,
        },
      });
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
        },
      };
    }
  }

  async fetchCandles({ symbol, interval, count, to }) {
    try {
      const normalized = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
      const candles = await this.marketData.getCandles({
        symbol: normalized,
        interval: interval || this.config.strategy.candleInterval,
        count: count || this.config.strategy.candleCount,
        to: to || null,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: candles,
      };
    } catch (error) {
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
        },
      };
    }
  }

  async getOrderChance(symbol) {
    try {
      const normalized = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
      const chance = await this.exchangeClient.getOrderChance({ symbol: normalized });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          symbol: normalized,
          market: toBithumbMarket(normalized),
          chance,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async accountList() {
    try {
      const payload = await this.exchangeClient.getAccounts();
      const accounts = normalizeAccounts(payload);
      const metrics = calculateAccountMetrics(accounts);
      await this.captureBalancesSnapshot("account_list", accounts);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          count: accounts.length,
          accounts,
          metrics,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async captureBalancesSnapshot(source, accounts = []) {
    const capturedAt = nowIso();
    await this.store.update((state) => {
      state.balancesSnapshot.push({
        id: uuid(),
        source,
        capturedAt,
        items: accounts,
      });
      return this.applyStateRetention(state);
    });
    return capturedAt;
  }

  getLatestBalancesSnapshot() {
    const snapshots = this.store.snapshot().balancesSnapshot || [];
    if (snapshots.length === 0) {
      return null;
    }
    return snapshots[snapshots.length - 1];
  }

  async loadAccountContext() {
    try {
      const payload = await this.exchangeClient.getAccounts();
      const accounts = normalizeAccounts(payload);
      await this.captureBalancesSnapshot("risk_context", accounts);
      return {
        accounts,
        metrics: calculateAccountMetrics(accounts),
        source: "exchange_accounts",
      };
    } catch (error) {
      const latest = this.getLatestBalancesSnapshot();
      if (latest?.items) {
        const metrics = calculateAccountMetrics(latest.items);
        return {
          accounts: latest.items,
          metrics,
          source: "snapshot_fallback",
          warning: error.message,
        };
      }
      return {
        accounts: [],
        metrics: {
          cashKrw: 0,
          exposureKrw: 0,
          equityKrw: 0,
          holdings: {},
        },
        source: "empty",
        warning: error.message,
      };
    }
  }

  async resolveSellOrderAmount({
    symbol,
    price,
    fallbackAmountKrw,
  } = {}) {
    const fallback = {
      amountKrw: fallbackAmountKrw,
      source: "fallback_amount",
      availableQty: null,
    };

    if (this.config.strategy.sellAllOnExit === false) {
      return fallback;
    }

    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const [baseCurrency] = normalizedSymbol.split("_");
    const resolvedPrice = asNumber(price, null);
    if (!baseCurrency || resolvedPrice === null || resolvedPrice <= 0) {
      return fallback;
    }

    const accountContext = await this.loadAccountContext();
    let availableQty = 0;
    for (const account of accountContext.accounts || []) {
      const currency = String(account.currency || "").trim().toUpperCase();
      const unitCurrency = String(account.unitCurrency || "KRW").trim().toUpperCase();
      if (currency !== baseCurrency || unitCurrency !== "KRW") {
        continue;
      }
      availableQty += Math.max(asNumber(account.balance, 0), 0);
    }

    const qtyPrecision = asPositiveInt(this.config.strategy.sellAllQtyPrecision, 8);
    const flooredQty = floorToDecimals(availableQty, qtyPrecision);
    if (!Number.isFinite(flooredQty) || flooredQty <= 0) {
      return {
        amountKrw: 0,
        source: "sell_all_no_position",
        availableQty: 0,
      };
    }

    const amountKrw = flooredQty * resolvedPrice;
    if (!Number.isFinite(amountKrw) || amountKrw <= 0) {
      return {
        amountKrw: 0,
        source: "sell_all_invalid_notional",
        availableQty: flooredQty,
      };
    }

    return {
      amountKrw,
      source: "sell_all_available_qty",
      availableQty: flooredQty,
    };
  }

  async resolveDailyPnl(equityKrw) {
    if (!Number.isFinite(equityKrw) || equityKrw <= 0) {
      return {
        tradeDate: toDateByTimezone(this.config.runtime.timezone),
        baselineEquityKrw: null,
        dailyPnlKrw: 0,
      };
    }

    const tradeDate = toDateByTimezone(this.config.runtime.timezone);
    let baseline = null;

    await this.store.update((state) => {
      const saved = state.settings.dailyPnlBaseline;
      const savedValue = asNumber(saved?.equityKrw, null);
      if (saved && saved.date === tradeDate && savedValue !== null && savedValue > 0) {
        baseline = savedValue;
        return state;
      }

      const configured = asNumber(this.config.risk.initialCapitalKrw, null);
      baseline = configured !== null && configured > 0 ? configured : equityKrw;
      state.settings.dailyPnlBaseline = {
        date: tradeDate,
        equityKrw: baseline,
        source: configured !== null && configured > 0 ? "initial_capital" : "first_equity_of_day",
        updatedAt: nowIso(),
      };
      return state;
    });

    return {
      tradeDate,
      baselineEquityKrw: baseline,
      dailyPnlKrw: equityKrw - baseline,
    };
  }

  async resolveOverlay() {
    const timeoutMs = this.config.overlay.timeoutMs;
    const timeoutResult = {
      multiplier: this.config.overlay.fallbackMultiplier,
      source: "overlay_timeout_fallback",
      stale: true,
      updatedAt: null,
      score: null,
      regime: null,
    };

    const overlay = await Promise.race([
      this.overlayEngine.readCurrent(),
      new Promise((resolve) => {
        setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);

    await this.store.update((state) => {
      if (!state.system) {
        state.system = {};
      }
      state.system.overlayCache = {
        ...overlay,
        observedAt: nowIso(),
      };
      return state;
    });

    return overlay;
  }

  buildOrderInput({
    symbol,
    side,
    type,
    amountKrw,
    price = null,
    expectedPrice = null,
    clientOrderKey = null,
    strategyRunId = "manual",
  }) {
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const normalizedSide = normalizeSide(side);
    const normalizedType = normalizeType(type);
    const parsedAmount = asNumber(amountKrw, null);
    if (parsedAmount === null || parsedAmount <= 0) {
      throw new Error("amount must be a positive number");
    }

    let parsedPrice = asNumber(price, null);
    const expected = asNumber(expectedPrice, null);
    let qty = null;

    if (normalizedType === "limit") {
      if (parsedPrice === null || parsedPrice <= 0) {
        throw new Error("limit order requires --price");
      }
      qty = computeQtyFromAmount(parsedAmount, parsedPrice);
    } else if (normalizedType === "market") {
      if (normalizedSide === "buy") {
        parsedPrice = parsedAmount;
        qty = 1;
      } else {
        if (parsedPrice === null || parsedPrice <= 0) {
          throw new Error("market sell requires --price to derive quantity from amount");
        }
        qty = computeQtyFromAmount(parsedAmount, parsedPrice);
      }
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error("unable to derive order quantity from amount/price");
    }

    return {
      symbol: normalizedSymbol,
      side: normalizedSide,
      type: normalizedType,
      amountKrw: parsedAmount,
      expectedPrice: Number.isFinite(expected) ? expected : null,
      price: parsedPrice,
      qty,
      clientOrderKey: clientOrderKey || buildClientOrderKey({
        strategyRunId,
        symbol: normalizedSymbol,
        side: normalizedSide,
        nowMs: Date.now(),
      }),
    };
  }

  async evaluateRiskForOrder(orderInput, { chanceMinTotalKrw = 0 } = {}) {
    const accountContext = await this.loadAccountContext();
    const pnlContext = await this.resolveDailyPnl(accountContext.metrics.equityKrw);
    const [baseCurrency] = String(orderInput.symbol || "").split("_");
    const availableCashKrw = asNumber(
      accountContext.metrics.availableCashKrw,
      accountContext.metrics.cashKrw,
    );
    const holdingQty = asNumber(
      accountContext.metrics.holdingsAvailable?.[baseCurrency],
      asNumber(accountContext.metrics.holdings?.[baseCurrency] || 0, 0),
    );
    const holdingPrice = asNumber(orderInput.price, null);
    const holdingNotionalKrw =
      holdingPrice !== null && holdingPrice > 0
        ? Math.max(0, holdingQty * holdingPrice)
        : 0;

    const risk = this.riskEngine.evaluate({
      amountKrw: orderInput.amountKrw,
      side: orderInput.side,
      killSwitch: this.store.snapshot().settings.killSwitch,
      openOrdersCount: this.getOpenOrdersCount(),
      openOrdersBySymbol: this.getOpenOrdersCount(orderInput.symbol),
      exposureKrw: accountContext.metrics.exposureKrw,
      availableCashKrw,
      dailyPnlKrw: pnlContext.dailyPnlKrw,
      chanceMinTotalKrw,
      holdingNotionalKrw,
    });

    return {
      risk,
      accountContext,
      pnlContext,
    };
  }

  async persistOrder(orderRecord, metadata = {}) {
    await this.store.update((state) => {
      const now = nowIso();
      const nowTs = Date.now();
      const existsIndex = state.orders.findIndex((order) => {
        if (orderRecord?.id && order.id === orderRecord.id) {
          return true;
        }
        if (orderRecord?.exchangeOrderId && order.exchangeOrderId === orderRecord.exchangeOrderId) {
          return true;
        }
        if (orderRecord?.clientOrderKey && order.clientOrderKey === orderRecord.clientOrderKey) {
          return true;
        }
        return false;
      });
      const next = {
        ...orderRecord,
        clientOrderKey: orderRecord?.clientOrderKey || null,
        createdAt: existsIndex >= 0 ? (state.orders[existsIndex]?.createdAt || nowIso()) : (orderRecord?.createdAt || now),
        updatedAt: now,
        metadata,
      };

      if (existsIndex >= 0) {
        state.orders[existsIndex] = {
          ...state.orders[existsIndex],
          ...next,
        };
      } else {
        state.orders.push(next);
      }

      state.orderEvents.push({
        id: uuid(),
        orderId: orderRecord.id,
        eventType: orderRecord.state,
        eventTs: now,
        payload: {
          symbol: orderRecord.symbol,
          side: orderRecord.side,
          type: orderRecord.type,
          amountKrw: orderRecord.amountKrw,
          exchangeOrderId: orderRecord.exchangeOrderId || null,
          clientOrderKey: orderRecord.clientOrderKey || null,
          metadata,
        },
      });

      const fills = fillRowsFromOrder(orderRecord);
      if (fills.length > 0) {
        const seenFillKeys = new Set();
        for (const fill of state.fills || []) {
          if (fill?.id) {
            seenFillKeys.add(fill.id);
          }
        }
        for (const fill of fills) {
          if (!fill?.id || seenFillKeys.has(fill.id)) {
            continue;
          }
          seenFillKeys.add(fill.id);
          state.fills.push({
            ...fill,
            eventTs: nowTs,
          });
        }
      }

      return this.applyStateRetention(state);
    });
  }

  async reconcileOrder(
    orderRecord,
    {
      attempts = 3,
      initialDelayMs = 350,
      maxDelayMs = 1_200,
      persist = true,
    } = {},
  ) {
    if (!orderRecord || (orderRecord.state && isTerminalOrderState(orderRecord.state))) {
      return orderRecord;
    }
    if (!orderRecord.exchangeOrderId && !orderRecord.clientOrderKey) {
      return orderRecord;
    }

    let current = { ...orderRecord };
    let delayMs = initialDelayMs;
    const total = Math.max(1, Math.floor(attempts));

    for (let i = 0; i < total; i += 1) {
      try {
        const status = await this.exchangeClient.getOrderStatus({
          exchangeOrderId: orderRecord.exchangeOrderId,
          symbol: orderRecord.symbol,
          clientOrderKey: orderRecord.clientOrderKey,
          orderHint: {
            side: orderRecord.side,
            type: orderRecord.type,
            price: orderRecord.price,
            qty: orderRecord.qty,
            createdAt: orderRecord.placedAt,
          },
        });
        current = normalizeOrderFromExchange(status, current);
        if (persist) {
          await this.persistOrder(current, {
            reason: "exchange_reconcile",
          });
        }
        if (isTerminalOrderState(current.state)) {
          return current;
        }
      } catch (error) {
        if (!this.exchangeClient.isRetryableError(error) || i >= total - 1) {
          return current;
        }
      }

      if (i < total - 1) {
        await this.sleepFn(Math.min(delayMs, maxDelayMs));
        delayMs = Math.min(maxDelayMs, Math.floor(delayMs * 1.7));
      }
    }

    return current;
  }

  async reconcileOpenOrders({ maxCandidates = 8 } = {}) {
    const openStates = openOrderStates();
    const allOpen = this.store.snapshot().orders.filter((order) => openStates.has(order?.state));
    const candidates = allOpen
      .filter((order) => order && (order.exchangeOrderId || order.clientOrderKey))
      .slice(-Math.max(1, Math.floor(maxCandidates)));
    let reconciled = 0;
    let failed = 0;

    for (const order of candidates) {
      try {
        const updated = await this.reconcileOrder(order, { attempts: 2, initialDelayMs: 150 });
        if (updated?.state && updated.state !== order.state) {
          reconciled += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return {
      openCount: allOpen.length,
      candidates: candidates.length,
      reconciled,
      failed,
    };
  }

  async placeOrder({
    symbol,
    side,
    type,
    amount,
    price = null,
    expectedPrice = null,
    dryRun = false,
    reason = "manual",
  }) {
    return this.withOrderSequence(async () => {
      try {
        const orderInput = this.buildOrderInput({
          symbol,
          side,
          type,
          amountKrw: amount,
          price,
          expectedPrice,
        });

      const chance = await this.exchangeClient.getOrderChance({ symbol: orderInput.symbol });
      const chanceMinTotalKrw = parseMinTotal(chance, orderInput.side);

      const context = await this.evaluateRiskForOrder(orderInput, { chanceMinTotalKrw });
      if (!context.risk.allowed) {
        const reasons = Array.isArray(context.risk.reasons) ? context.risk.reasons : [];
        const hitDailyLossLimit = reasons.some((reason) => reason?.rule === "MAX_DAILY_LOSS_KRW");
        const streak = await this.bumpRiskRejectStreak({
          symbol: orderInput.symbol,
          reasons,
          metrics: context.risk.metrics,
        });
        await this.recordRiskEvent({
          type: "order_rejected",
          source: "risk_engine",
          symbol: orderInput.symbol,
          reasons,
          metrics: context.risk.metrics,
          streak,
        });

        if (hitDailyLossLimit && !this.store.snapshot().settings.killSwitch) {
          await this.setKillSwitch(true, "max_daily_loss_reached");
          this.logger.warn("kill switch auto-activated by risk policy", {
            rule: "MAX_DAILY_LOSS_KRW",
            symbol: orderInput.symbol,
            dailyPnlKrw: context.risk.metrics.dailyPnlKrw,
            maxDailyLossKrw: this.config.risk.maxDailyLossKrw,
          });
        }

        const maxRiskRejectStreak = asNumber(this.config.risk.maxConsecutiveRiskRejects, 0);
        if (maxRiskRejectStreak > 0 && streak >= maxRiskRejectStreak && !this.store.snapshot().settings.killSwitch) {
          await this.setKillSwitch(true, "max_consecutive_risk_rejects");
          this.logger.error("kill switch auto-activated by risk-reject streak", {
            symbol: orderInput.symbol,
            streak,
            limit: maxRiskRejectStreak,
          });
        }
        return {
          ok: false,
          code: EXIT_CODES.RISK_REJECTED,
          error: {
            message: "Risk policy rejected order",
            reasons,
            metrics: context.risk.metrics,
          },
        };
      }

      await this.clearRiskRejectStreak();

      if (dryRun) {
        return {
          ok: true,
            code: EXIT_CODES.OK,
            data: {
              dryRun: true,
              orderInput,
            risk: context.risk,
            pnl: context.pnlContext,
            account: {
              source: context.accountContext.source,
              metrics: context.accountContext.metrics,
            },
            expectedPrice,
          },
        };
      }

        const submitted = await this.executionEngine.submit(orderInput);
        submitted.expectedPrice = orderInput.expectedPrice;
        let reconciled = await this.reconcileOrder(submitted, { persist: false });
        if (!reconciled) {
          reconciled = submitted;
        }

        await this.persistOrder(reconciled, {
          reason,
        });

        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: reconciled,
        };
      } catch (error) {
        const code = this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL;
        return {
          ok: false,
          code,
          error: {
            message: error.message,
          },
        };
      }
    });
  }

  async runStrategyOnce({ symbol = null, amount = null, dryRun = false } = {}) {
    const runId = uuid();
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const startedAt = nowIso();
    const autoSellEnabled = this.config.strategy.autoSellEnabled !== false;

    const runBase = {
      id: runId,
      strategy: this.config.strategy.name,
      symbol: normalizedSymbol,
      startedAt,
      mode: "live",
      dryRun: Boolean(dryRun),
      status: "RUNNING",
    };

    await this.store.update((state) => {
      state.strategyRuns.push(runBase);
      return this.applyStateRetention(state);
    });

    try {
      const candleRes = await this.fetchCandles({
        symbol: normalizedSymbol,
        interval: this.config.strategy.candleInterval,
        count: this.config.strategy.candleCount,
      });

      if (!candleRes.ok) {
        await this.finishRun(runId, "FAILED", {
          error: candleRes.error,
        });
        return candleRes;
      }

      const signal = this.signalEngine.evaluate(candleRes.data.candles);
      const overlay = await this.resolveOverlay();
      const baseAmount = asNumber(amount, null) ?? this.config.strategy.baseOrderAmountKrw;
      const signalMultiplier = signalRiskMultiplier(signal, this.config);
      const totalMultiplier = Math.max(0.01, overlay.multiplier * signalMultiplier);
      const adjustedAmount = Math.max(1, Math.round(baseAmount * totalMultiplier));
      const lastClose = asNumber(candleRes.data.candles.at(-1)?.close, null);
      const protectiveExit = await this.resolveProtectiveExit({
        symbol: normalizedSymbol,
        currentPrice: lastClose,
      });
      const forcedExit = protectiveExit?.shouldExit ? true : false;
      const reason = protectiveExit?.reason || signal.reason;
      const action = forcedExit ? protectiveExit.action : signal.action;
      const orderSide = action === "SELL" ? "sell" : "buy";
      let submittedAmountKrw = adjustedAmount;
      let sellPlan = null;

      if (forcedExit) {
        await this.recordRiskEvent({
          type: "protective_exit",
          source: "risk_exit_rule",
          symbol: normalizedSymbol,
          reason,
          pnlRatio: protectiveExit.pnlRatio,
          avgBuyPrice: protectiveExit.avgBuyPrice,
          currentPrice: protectiveExit.currentPrice,
        });
      }

      if (orderSide === "sell") {
        const lastClose = asNumber(candleRes.data.candles.at(-1)?.close, null);
        sellPlan = await this.resolveSellOrderAmount({
          symbol: normalizedSymbol,
          price: lastClose,
          fallbackAmountKrw: adjustedAmount,
        });
        submittedAmountKrw = asNumber(sellPlan.amountKrw, adjustedAmount);
      }

      const decision = {
        signal,
        overlay,
        amountBaseKrw: baseAmount,
        amountAdjustedKrw: adjustedAmount,
        amountSubmittedKrw: submittedAmountKrw,
        signalMultiplier,
        totalMultiplier,
        sellPlan,
        protectiveExit,
      };

      const actionable = forcedExit || signal.action === "BUY" || (autoSellEnabled && signal.action === "SELL");
      if (!actionable) {
        const result = {
          runId,
          ...decision,
          order: null,
          note: "no execution for non-actionable signal",
        };
        await this.finishRun(runId, "COMPLETED", { result });
        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: result,
        };
      }

      if (!Number.isFinite(submittedAmountKrw) || submittedAmountKrw <= 0) {
        const result = {
          runId,
          ...decision,
          order: null,
          note: "sell skipped: no available position",
        };
        await this.finishRun(runId, "COMPLETED", { result });
        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: result,
        };
      }

      const order = await this.placeOrder({
        symbol: normalizedSymbol,
        side: orderSide,
        type: "market",
        amount: submittedAmountKrw,
        price: orderSide === "sell" ? lastClose : null,
        expectedPrice: lastClose,
        dryRun,
        reason: `strategy:${this.config.strategy.name}:${reason}`,
      });

      if (!order.ok) {
        await this.finishRun(runId, "FAILED", {
          result: decision,
          error: order.error,
        });
        return order;
      }

      const result = {
        runId,
        ...decision,
        order: order.data,
      };
      await this.finishRun(runId, "COMPLETED", { result });
      await this.store.update((state) => {
        if (!state.system) {
          state.system = {};
        }
        state.system.lastRun = {
          runId,
          status: "COMPLETED",
          at: nowIso(),
          signal: signal.action,
        };
        return state;
      });

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: result,
      };
    } catch (error) {
      await this.finishRun(runId, "FAILED", {
        error: {
          message: error.message,
        },
      });
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async finishRun(runId, status, patch = {}) {
    await this.store.update((state) => {
      const run = state.strategyRuns.find((item) => item.id === runId);
      if (!run) {
        return state;
      }
      run.status = status;
      run.endedAt = nowIso();
      Object.assign(run, patch);
      return state;
    });
  }

  async runStrategyLoop({ symbol = null, amount = null, intervalSec = 10, maxCycles = 0, dryRun = false } = {}) {
    const cycleLimit = Number.isFinite(Number(maxCycles)) ? Math.max(0, Math.floor(Number(maxCycles))) : 0;
    const waitSec = Number.isFinite(Number(intervalSec)) ? Math.max(1, Math.floor(Number(intervalSec))) : 10;

    let cycles = 0;
    let buySignals = 0;
    const startedAt = nowIso();

    while (true) {
      const result = await this.runStrategyOnce({ symbol, amount, dryRun });
      cycles += 1;
      if (result.ok && result.data?.signal?.action === "BUY") {
        buySignals += 1;
      }

      if (cycleLimit > 0 && cycles >= cycleLimit) {
        break;
      }

      await this.sleepFn(waitSec * 1000);
    }

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        startedAt,
        endedAt: nowIso(),
        cycles,
        buySignals,
        intervalSec: waitSec,
        maxCycles: cycleLimit,
        dryRun: Boolean(dryRun),
      },
    };
  }

  async overlayShow() {
    try {
      const overlay = await this.overlayEngine.readCurrent();
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: overlay,
      };
    } catch (error) {
      return {
        ok: false,
        code: EXIT_CODES.INTERNAL_ERROR,
        error: {
          message: error.message,
        },
      };
    }
  }

  async overlaySet({ multiplier, score, regime, note }) {
    try {
      const overlay = await this.overlayEngine.setCurrent({ multiplier, score, regime, note });
      await this.store.update((state) => {
        if (!state.system) {
          state.system = {};
        }
        state.system.overlayCache = {
          ...overlay,
          observedAt: nowIso(),
        };
        return state;
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: overlay,
      };
    } catch (error) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: error.message,
        },
      };
    }
  }

  async orderList(options = {}) {
    try {
      const parseArrayOption = (value) => {
        if (Array.isArray(value)) {
          const rows = value.map((item) => String(item || "").trim()).filter(Boolean);
          return rows.length > 0 ? rows : null;
        }
        if (typeof value === "string") {
          const rows = value.split(",").map((item) => item.trim()).filter(Boolean);
          return rows.length > 0 ? rows : null;
        }
        return null;
      };

      const payload = await this.exchangeClient.listOrders({
        symbol: options.symbol || null,
        uuids: parseArrayOption(options.uuids),
        state: options.state || null,
        states: parseArrayOption(options.states),
        page: options.page || 1,
        limit: options.limit || 100,
        orderBy: options.orderBy || "desc",
      });

      const rows = toOrderListRows(payload);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "exchange",
          count: rows.length,
          orders: rows,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async orderGet(orderId, symbol = null) {
    const requested = String(orderId || "").trim();
    if (!requested) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: "Missing required option --id",
        },
      };
    }

    const local = this.store.snapshot().orders.find((order) => order.id === requested || order.exchangeOrderId === requested);

    try {
      const payload = await this.exchangeClient.getOrder({
        exchangeOrderId: local?.exchangeOrderId || requested,
        symbol: symbol || local?.symbol || null,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "exchange",
          order: payload,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async orderCancel(orderId, symbol = null) {
    const requested = String(orderId || "").trim();
    if (!requested) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: "Missing required option --id",
        },
      };
    }

    const local = this.store.snapshot().orders.find((order) => order.id === requested || order.exchangeOrderId === requested);

    try {
      const exchangeOrderId = local?.exchangeOrderId || requested;
      const payload = await this.exchangeClient.cancelOrder({
        exchangeOrderId,
        symbol: symbol || local?.symbol || null,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "exchange",
          exchangeOrderId,
          response: payload,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }
}
