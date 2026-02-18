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

function normalizePaperWallet(wallet, initialCashKrw) {
  const normalizedInitialCash = asNumber(initialCashKrw, 1_000_000);
  const safeInitialCash = normalizedInitialCash !== null && normalizedInitialCash > 0 ? normalizedInitialCash : 1_000_000;

  const base = {
    cashKrw: safeInitialCash,
    holdings: {},
    initializedAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (!wallet || typeof wallet !== "object") {
    return base;
  }

  const cashKrw = asNumber(wallet.cashKrw, safeInitialCash);
  const holdingsRaw = wallet.holdings && typeof wallet.holdings === "object" ? wallet.holdings : {};
  const holdings = {};

  for (const [currencyRaw, row] of Object.entries(holdingsRaw)) {
    const currency = String(currencyRaw || "").trim().toUpperCase();
    if (!currency) {
      continue;
    }

    const quantity = Math.max(asNumber(row?.quantity, 0), 0);
    if (quantity <= 0) {
      continue;
    }

    const avgBuyPrice = Math.max(asNumber(row?.avgBuyPrice, 0), 0);
    holdings[currency] = {
      quantity,
      avgBuyPrice,
      updatedAt: row?.updatedAt || nowIso(),
    };
  }

  return {
    cashKrw: Math.max(cashKrw, 0),
    holdings,
    initializedAt: wallet.initializedAt || nowIso(),
    updatedAt: wallet.updatedAt || nowIso(),
  };
}

function buildPaperAccountsFromWallet(wallet) {
  const accounts = [
    {
      currency: "KRW",
      unitCurrency: "KRW",
      symbol: "KRW_KRW",
      balance: Math.max(asNumber(wallet?.cashKrw, 0), 0),
      locked: 0,
      avgBuyPrice: 0,
      raw: {
        source: "paper_wallet",
      },
    },
  ];

  const holdings = wallet?.holdings && typeof wallet.holdings === "object" ? wallet.holdings : {};
  for (const [currencyRaw, row] of Object.entries(holdings)) {
    const currency = String(currencyRaw || "").trim().toUpperCase();
    if (!currency) {
      continue;
    }

    const quantity = Math.max(asNumber(row?.quantity, 0), 0);
    if (quantity <= 0) {
      continue;
    }

    const avgBuyPrice = Math.max(asNumber(row?.avgBuyPrice, 0), 0);
    accounts.push({
      currency,
      unitCurrency: "KRW",
      symbol: `${currency}_KRW`,
      balance: quantity,
      locked: 0,
      avgBuyPrice,
      raw: {
        source: "paper_wallet",
      },
    });
  }

  return accounts;
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

function requiredRealtimePriceWindow(config) {
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
  let exposureKrw = 0;

  const holdings = {};
  for (const account of accounts) {
    const currency = String(account.currency || "").toUpperCase();
    const unitCurrency = String(account.unitCurrency || "KRW").toUpperCase();
    const quantity = Math.max(asNumber(account.balance, 0) + asNumber(account.locked, 0), 0);

    if (!currency || quantity <= 0) {
      continue;
    }

    if (currency === "KRW") {
      cashKrw += quantity;
      continue;
    }

    holdings[currency] = (holdings[currency] || 0) + quantity;

    if (unitCurrency === "KRW") {
      const avgBuyPrice = asNumber(account.avgBuyPrice, null);
      if (avgBuyPrice !== null && avgBuyPrice > 0) {
        exposureKrw += quantity * avgBuyPrice;
      }
    }
  }

  return {
    cashKrw,
    exposureKrw,
    equityKrw: cashKrw + exposureKrw,
    holdings,
  };
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
  return new Set(["NEW", "ACCEPTED", "PARTIAL", "UNKNOWN_SUBMIT", "CANCEL_REQUESTED"]);
}

function candlesFromPrices(prices = []) {
  return prices.map((price, index) => ({
    timestamp: index + 1,
    high: price,
    low: price,
    close: price,
  }));
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
      const filteredEvents = orderEvents.filter((event) => {
        if (knownOrderIds.has(event?.orderId)) {
          return true;
        }
        const key = event?.payload?.clientOrderKey;
        return key ? knownOrderKeys.has(key) : false;
      });
      state.orderEvents = trimTail(filteredEvents, retention.orderEvents);

      state.strategyRuns = trimTail(state.strategyRuns, 1);
      state.balancesSnapshot = trimTail(state.balancesSnapshot, 1);
      state.fills = trimTail(state.fills, retention.fills);
      state.riskEvents = trimTail(state.riskEvents, 100);
      state.systemHealth = trimTail(state.systemHealth, 100);
      state.agentAudit = trimTail(state.agentAudit, 100);
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
      state.paperWallet = normalizePaperWallet(
        state.paperWallet,
        this.config.runtime.paperInitialCashKrw,
      );

      // Always align persisted runtime mode with current config at startup.
      // This prevents stale state.json from silently forcing paper mode in live runs.
      state.settings.paperMode = Boolean(this.config.runtime.paperMode);
      state.settings.paperModeInitialized = true;
      state.settings.paperReason = "runtime_config";
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

  paperMode() {
    return Boolean(this.store.snapshot().settings.paperMode);
  }

  hasKeys() {
    return Boolean(this.config.exchange.accessKey && this.config.exchange.secretKey);
  }

  getPaperWallet() {
    const state = this.store.snapshot();
    return normalizePaperWallet(state.paperWallet, this.config.runtime.paperInitialCashKrw);
  }

  async ensurePaperWallet() {
    await this.store.update((state) => {
      state.paperWallet = normalizePaperWallet(state.paperWallet, this.config.runtime.paperInitialCashKrw);
      return state;
    });
    return this.getPaperWallet();
  }

  getOpenOrdersCount() {
    const state = this.store.snapshot();
    const openStates = openOrderStates();
    return state.orders.filter((order) => openStates.has(order.state)).length;
  }

  async status() {
    const state = this.store.snapshot();
    const paperWallet = this.paperMode() ? normalizePaperWallet(state.paperWallet, this.config.runtime.paperInitialCashKrw) : null;
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        now: nowIso(),
        mode: this.paperMode() ? "paper" : "live",
        killSwitch: Boolean(state.settings.killSwitch),
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
        lastRun: state.system?.lastRun || null,
        paper: paperWallet
          ? {
              cashKrw: paperWallet.cashKrw,
              holdings: paperWallet.holdings,
            }
          : null,
      },
    };
  }

  async setPaperMode(enabled, reason = null) {
    await this.store.update((state) => {
      state.settings.paperMode = Boolean(enabled);
      state.settings.paperReason = reason || null;
      if (state.settings.paperMode) {
        state.paperWallet = normalizePaperWallet(
          state.paperWallet,
          this.config.runtime.paperInitialCashKrw,
        );
      }
      return state;
    });

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        paperMode: Boolean(enabled),
        reason: reason || null,
      },
    };
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
    const windowSize = requiredRealtimePriceWindow(this.config);
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
        mode: this.paperMode() ? "paper" : "live",
        dryRun: Boolean(dryRun),
        status: "RUNNING",
      });
      return this.applyStateRetention(state);
    });

    const prices = [];
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
          prices.push(tick.tradePrice);
          if (prices.length > windowSize) {
            prices.splice(0, prices.length - windowSize);
          }

          processing = processing
            .then(async () => {
              if (prices.length < windowSize) {
                return;
              }

              const signal = this.signalEngine.evaluate(candlesFromPrices(prices));
              if (signal.action === "BUY") {
                buySignals += 1;
              } else {
                sellSignals += 1;
              }

              let selectedAction = null;
              let selectedReason = signal.reason;
              let selectedSource = "rule_signal";
              const canUseOverride =
                aiPolicy.mode === "override" &&
                aiPolicy.forceAction &&
                !(aiPolicy.forceOnce && overrideActionConsumed);

              if (canUseOverride) {
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
                  if (selectedSource === "ai_override" && aiPolicy.forceOnce) {
                    overrideActionConsumed = true;
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

              const order = await this.placeOrder({
                symbol: normalizedSymbol,
                side: orderSide,
                type: "market",
                amount: orderAmountKrw,
                price: orderSide === "sell" ? tick.tradePrice : null,
                dryRun,
                reason: `strategy:${this.config.strategy.name}:realtime:${selectedReason}`,
              });
              if (selectedSource === "ai_override" && aiPolicy.forceOnce) {
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
    if (this.paperMode()) {
      const wallet = await this.ensurePaperWallet();
      const accounts = buildPaperAccountsFromWallet(wallet);
      const metrics = calculateAccountMetrics(accounts);
      await this.captureBalancesSnapshot("paper_account_list", accounts);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "paper_wallet",
          count: accounts.length,
          accounts,
          metrics,
        },
      };
    }

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
    if (this.paperMode()) {
      const wallet = await this.ensurePaperWallet();
      const accounts = buildPaperAccountsFromWallet(wallet);
      await this.captureBalancesSnapshot("paper_risk_context", accounts);
      return {
        accounts,
        metrics: calculateAccountMetrics(accounts),
        source: "paper_wallet",
      };
    }

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

  async resolvePaperFillPrice(orderInput) {
    const explicitPrice = asNumber(orderInput.price, null);
    const isMarketBuy = orderInput.type === "market" && orderInput.side === "buy";
    if (!isMarketBuy && explicitPrice !== null && explicitPrice > 0) {
      return explicitPrice;
    }

    const ticker = await this.marketData.getMarketTicker(orderInput.symbol);
    const metrics = this.marketData.extractTickerMetrics(ticker);
    const lastPrice = asNumber(metrics?.lastPrice, null);
    if (lastPrice === null || lastPrice <= 0) {
      throw new Error(`Unable to resolve paper fill price for ${orderInput.symbol}`);
    }
    return lastPrice;
  }

  async applyPaperOrderToWallet(orderInput, fillPrice) {
    const [baseCurrency, quoteCurrency] = String(orderInput.symbol || "").split("_");
    if (!baseCurrency || quoteCurrency !== "KRW") {
      throw new Error(`Paper trading supports *_KRW symbols only: ${orderInput.symbol}`);
    }

    const resolvedFillPrice = asNumber(fillPrice, null);
    if (resolvedFillPrice === null || resolvedFillPrice <= 0) {
      throw new Error("Invalid paper fill price");
    }

    const qty = computeQtyFromAmount(orderInput.amountKrw, resolvedFillPrice);
    if (qty === null || qty <= 0) {
      throw new Error("Unable to derive paper quantity from amount/price");
    }

    let fillResult = null;
    await this.store.update((state) => {
      state.paperWallet = normalizePaperWallet(
        state.paperWallet,
        this.config.runtime.paperInitialCashKrw,
      );
      const wallet = state.paperWallet;
      const now = nowIso();
      const holding = wallet.holdings[baseCurrency] || {
        quantity: 0,
        avgBuyPrice: 0,
        updatedAt: now,
      };

      if (orderInput.side === "buy") {
        if (wallet.cashKrw + 1e-9 < orderInput.amountKrw) {
          throw new Error(
            `Paper cash insufficient: ${wallet.cashKrw.toFixed(2)} < ${orderInput.amountKrw.toFixed(2)}`,
          );
        }

        const prevQty = Math.max(asNumber(holding.quantity, 0), 0);
        const prevAvg = Math.max(asNumber(holding.avgBuyPrice, 0), 0);
        const newQty = prevQty + qty;
        const newAvg = newQty > 0 ? (prevQty * prevAvg + qty * resolvedFillPrice) / newQty : 0;

        wallet.cashKrw = Math.max(0, wallet.cashKrw - orderInput.amountKrw);
        wallet.holdings[baseCurrency] = {
          quantity: newQty,
          avgBuyPrice: newAvg,
          updatedAt: now,
        };
      } else {
        const heldQty = Math.max(asNumber(holding.quantity, 0), 0);
        if (heldQty + 1e-9 < qty) {
          throw new Error(`Paper holding insufficient: ${baseCurrency} ${heldQty} < ${qty}`);
        }

        const proceeds = qty * resolvedFillPrice;
        const remainingQty = Math.max(0, heldQty - qty);
        wallet.cashKrw += proceeds;

        if (remainingQty <= 1e-8) {
          delete wallet.holdings[baseCurrency];
        } else {
          wallet.holdings[baseCurrency] = {
            quantity: remainingQty,
            avgBuyPrice: Math.max(asNumber(holding.avgBuyPrice, 0), 0),
            updatedAt: now,
          };
        }
      }

      wallet.updatedAt = now;
      fillResult = {
        side: orderInput.side,
        symbol: orderInput.symbol,
        fillPrice: resolvedFillPrice,
        qty,
        notionalKrw: qty * resolvedFillPrice,
        walletAfter: {
          cashKrw: wallet.cashKrw,
          holdings: wallet.holdings,
        },
      };
      return state;
    });

    return fillResult;
  }

  buildOrderInput({ symbol, side, type, amountKrw, price = null, clientOrderKey = null, strategyRunId = "manual" }) {
    const normalizedSymbol = normalizeSymbol(symbol || this.config.strategy.defaultSymbol);
    const normalizedSide = normalizeSide(side);
    const normalizedType = normalizeType(type);
    const parsedAmount = asNumber(amountKrw, null);
    if (parsedAmount === null || parsedAmount <= 0) {
      throw new Error("amount must be a positive number");
    }

    let parsedPrice = asNumber(price, null);
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
    const availableCashKrw = asNumber(accountContext.metrics.cashKrw, 0);
    const holdingQty = asNumber(accountContext.metrics.holdings?.[baseCurrency] || 0, 0);
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
      state.orders.push({
        ...orderRecord,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        metadata,
      });

      state.orderEvents.push({
        id: uuid(),
        orderId: orderRecord.id,
        eventType: orderRecord.state,
        eventTs: nowIso(),
        payload: {
          symbol: orderRecord.symbol,
          side: orderRecord.side,
          type: orderRecord.type,
          amountKrw: orderRecord.amountKrw,
        },
      });
      return this.applyStateRetention(state);
    });
  }

  async placeOrder({ symbol, side, type, amount, price = null, dryRun = false, reason = "manual" }) {
    try {
      const orderInput = this.buildOrderInput({
        symbol,
        side,
        type,
        amountKrw: amount,
        price,
      });

      let chanceMinTotalKrw = 0;
      if (!this.paperMode()) {
        const chance = await this.exchangeClient.getOrderChance({ symbol: orderInput.symbol });
        chanceMinTotalKrw = parseMinTotal(chance, orderInput.side);
      }

      const context = await this.evaluateRiskForOrder(orderInput, { chanceMinTotalKrw });
      if (!context.risk.allowed) {
        return {
          ok: false,
          code: EXIT_CODES.RISK_REJECTED,
          error: {
            message: "Risk policy rejected order",
            reasons: context.risk.reasons,
            metrics: context.risk.metrics,
          },
        };
      }

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
          },
        };
      }

      let submitted;
      if (this.paperMode()) {
        const fillPrice = await this.resolvePaperFillPrice(orderInput);
        const fill = await this.applyPaperOrderToWallet(orderInput, fillPrice);
        submitted = {
          id: uuid(),
          exchangeOrderId: null,
          state: "FILLED",
          paper: true,
          placedAt: nowIso(),
          side: orderInput.side,
          type: orderInput.type,
          symbol: orderInput.symbol,
          amountKrw: fill.notionalKrw,
          price: fill.fillPrice,
          qty: fill.qty,
          clientOrderKey: orderInput.clientOrderKey,
          raw: {
            source: "paper_wallet",
            fill,
          },
        };
      } else {
        submitted = await this.executionEngine.submit(orderInput);
      }

      await this.persistOrder(submitted, {
        reason,
      });

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: submitted,
      };
    } catch (error) {
      const code = this.exchangeClient.isRetryableError(error) ? EXIT_CODES.EXCHANGE_RETRYABLE : EXIT_CODES.EXCHANGE_FATAL;
      return {
        ok: false,
        code,
        error: {
          message: error.message,
        },
      };
    }
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
      mode: this.paperMode() ? "paper" : "live",
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
      const orderSide = signal.action === "SELL" ? "sell" : "buy";
      let submittedAmountKrw = adjustedAmount;
      let sellPlan = null;

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
      };

      const actionable = signal.action === "BUY" || (autoSellEnabled && signal.action === "SELL");
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
        price: orderSide === "sell" ? asNumber(candleRes.data.candles.at(-1)?.close, null) : null,
        dryRun,
        reason: `strategy:${this.config.strategy.name}:${signal.reason}`,
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
      if (this.paperMode()) {
        const rows = this.store.snapshot().orders;
        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: {
            source: "local_paper",
            count: rows.length,
            orders: rows,
          },
        };
      }

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
    if (local?.paper) {
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "local_paper",
          order: local,
        },
      };
    }

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
    if (local?.paper) {
      await this.store.update((state) => {
        const target = state.orders.find((order) => order.id === local.id);
        if (target) {
          target.state = "CANCELED";
          target.updatedAt = nowIso();
        }
        return state;
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "local_paper",
          id: local.id,
          state: "CANCELED",
        },
      };
    }

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
