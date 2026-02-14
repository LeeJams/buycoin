import { EXIT_CODES } from "../config/exit-codes.js";
import { toBithumbMarket } from "../config/defaults.js";
import { uuid } from "../lib/ids.js";
import { invalidArg, isCliError } from "../lib/errors.js";
import { logger as defaultLogger } from "../lib/output.js";
import { nowIso } from "../lib/time.js";
import { AgentPolicy } from "./agent-policy.js";
import { normalizeAccounts } from "./account-normalizer.js";
import { MarketDataService } from "./market-data.js";
import { OrderManager } from "./order-manager.js";
import { RiskEngine } from "./risk-engine.js";
import { SymbolSelector } from "./symbol-selector.js";
import { StateSync } from "./state-sync.js";
import { StateStore } from "./store.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { calculateRsi, evaluateRsiSignal } from "../strategy/rsi.js";

function normalizeSide(side) {
  const s = String(side || "").toLowerCase();
  if (!["buy", "sell"].includes(s)) {
    throw invalidArg(`Invalid side: ${side}`, {
      field: "side",
      allowed: ["buy", "sell"],
      input: side,
    });
  }
  return s;
}

function normalizeOrderType(type) {
  const t = String(type || "limit").toLowerCase();
  if (!["limit", "market", "price"].includes(t)) {
    throw invalidArg(`Invalid order type: ${type}`, {
      field: "type",
      allowed: ["limit", "market", "price"],
      input: type,
    });
  }
  return t;
}

function normalizeUnknownResolveAction(action) {
  const normalized = String(action || "force-close").trim().toLowerCase();
  if (normalized === "force-close") {
    return {
      action: normalized,
      nextState: "CANCELED",
    };
  }
  if (normalized === "mark-rejected") {
    return {
      action: normalized,
      nextState: "REJECTED",
    };
  }

  throw invalidArg(`Invalid unknown resolve action: ${action}`, {
    field: "action",
    allowed: ["force-close", "mark-rejected"],
    input: action,
  });
}

function parseAmount(value, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw invalidArg(`Invalid ${label}: ${value}`, {
      field: label,
      input: value,
      reason: "must_be_positive_number",
    });
  }
  return num;
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function toCeilFixed(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.ceil(value * factor) / factor;
}

function extractChanceMinTotalKrw(payload, side) {
  const market = payload?.market && typeof payload.market === "object" ? payload.market : {};
  const sideNode = String(side || "").toLowerCase() === "sell" ? market.ask : market.bid;
  const sideMin = asPositiveNumber(sideNode?.min_total);
  if (sideMin !== null) {
    return sideMin;
  }

  const fallbackMin = asPositiveNumber(market.min_total);
  if (fallbackMin !== null) {
    return fallbackMin;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateByTimezone(timezone = "Asia/Seoul") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function latestIso(items = [], key = "eventTs") {
  let latest = null;
  for (const item of items) {
    const value = item?.[key];
    const ts = Date.parse(value || "");
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (!latest || ts > Date.parse(latest)) {
      latest = value;
    }
  }
  return latest;
}

function oldestIso(items = [], key = "eventTs") {
  let oldest = null;
  for (const item of items) {
    const value = item?.[key];
    const ts = Date.parse(value || "");
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (!oldest || ts < Date.parse(oldest)) {
      oldest = value;
    }
  }
  return oldest;
}

function asOrderRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.orders)) {
    return payload.orders;
  }
  if (Array.isArray(payload?.result)) {
    return payload.result;
  }
  if (payload && typeof payload === "object" && (payload.uuid || payload.id || payload.order_id || payload.orderId)) {
    return [payload];
  }
  return [];
}

function normalizeOrderStateParam(value, fieldName) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  const allowed = ["wait", "watch", "done", "cancel"];
  if (!allowed.includes(normalized)) {
    throw invalidArg(`Invalid ${fieldName}: ${value}`, {
      field: fieldName,
      allowed,
      input: value,
    });
  }
  return normalized;
}

function normalizeOrderListQuery(options = {}) {
  const uuids = Array.isArray(options.uuids)
    ? options.uuids.map((item) => String(item || "").trim()).filter(Boolean)
    : null;

  const state = options.state ? normalizeOrderStateParam(options.state, "state") : null;
  const statesRaw = Array.isArray(options.states)
    ? options.states.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const states = statesRaw.length > 0
    ? statesRaw.map((item) => normalizeOrderStateParam(item, "states"))
    : null;

  if (state && states) {
    throw invalidArg("Use either --state or --states (not both)", {
      field: "state|states",
      reason: "mutually_exclusive",
    });
  }

  const page = options.page === undefined || options.page === null ? 1 : Number(options.page);
  if (!Number.isInteger(page) || page < 1) {
    throw invalidArg(`Invalid page: ${options.page}`, {
      field: "page",
      input: options.page,
      reason: "must_be_integer_gte_1",
    });
  }

  const limit = options.limit === undefined || options.limit === null ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidArg(`Invalid limit: ${options.limit}`, {
      field: "limit",
      input: options.limit,
      reason: "must_be_integer_1_to_100",
    });
  }

  const orderBy = String(options.orderBy || "desc").trim().toLowerCase();
  if (!["asc", "desc"].includes(orderBy)) {
    throw invalidArg(`Invalid orderBy: ${options.orderBy}`, {
      field: "orderBy",
      allowed: ["asc", "desc"],
      input: options.orderBy,
    });
  }

  return {
    symbol: options.symbol ? String(options.symbol).toUpperCase() : null,
    uuids: uuids && uuids.length > 0 ? uuids : null,
    state,
    states,
    page,
    limit,
    orderBy,
  };
}

function pickExchangeOrderId(status = {}) {
  const candidates = [status.uuid, status.order_id, status.orderId, status.id];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

export class TraderService {
  constructor(config, deps = {}) {
    this.config = config;
    this.logger = deps.logger || defaultLogger;
    this.store =
      deps.store ||
      new StateStore(config.runtime.stateFile, {
        lockStaleMs: config.runtime.stateLockStaleMs,
      });
    this.exchangeClient = deps.exchangeClient || new BithumbClient(config, this.logger);
    this.marketData = deps.marketData || new MarketDataService(config, this.exchangeClient);
    this.symbolSelector = deps.symbolSelector || new SymbolSelector(config, this.marketData);
    this.riskEngine = deps.riskEngine || new RiskEngine(config, this.store);
    this.orderManager = deps.orderManager || new OrderManager(config, this.store, this.exchangeClient, this.logger);
    this.stateSync = deps.stateSync || new StateSync(this.store, this.exchangeClient, this.logger);
    this.agentPolicy = deps.agentPolicy || new AgentPolicy(this.store, config);
    this.sleepFn = deps.sleepFn || sleep;
  }

  async init() {
    await this.store.init();
    await this.store.update((state) => {
      if (typeof state.settings.paperMode !== "boolean") {
        state.settings.paperMode = this.config.trading.defaultPaperMode;
      }
      return state;
    });

    if (this.config.runtime.startupReconcile) {
      const unknownCount = this.store
        .snapshot()
        .orders.filter((order) => order.state === "UNKNOWN_SUBMIT").length;
      if (unknownCount > 0) {
        this.logger.warn("startup reconcile for unknown orders", { unknownCount });
        const reconcile = await this.reconcile();
        await this.pushSystemHealth("STARTUP_RECONCILE", {
          unknownCount,
          ok: reconcile.ok,
          code: reconcile.code,
        });
      }
    }
  }

  async enforcePolicy(context) {
    const policyResult = await this.agentPolicy.enforce(context);
    if (!policyResult.ok) {
      return {
        ok: false,
        code: policyResult.code,
        error: policyResult.error,
      };
    }
    return { ok: true };
  }

  paperMode() {
    return Boolean(this.store.snapshot().settings.paperMode);
  }

  async pushSystemHealth(eventType, detail = {}, severity = "INFO") {
    await this.store.update((state) => {
      state.systemHealth.push({
        id: uuid(),
        eventType,
        severity,
        detail,
        eventTs: nowIso(),
      });

      if (state.systemHealth.length > 500) {
        state.systemHealth = state.systemHealth.slice(-500);
      }
      return state;
    });
  }

  recentRetryableFailures() {
    const windowMs = this.config.resilience.autoKillSwitchWindowSec * 1000;
    const cutoff = Date.now() - windowMs;
    return this.store
      .snapshot()
      .systemHealth.filter((event) => {
        if (event.eventType !== "RETRYABLE_ORDER_FAILURE") {
          return false;
        }
        const ts = Date.parse(event.eventTs);
        return Number.isFinite(ts) && ts >= cutoff;
      }).length;
  }

  async maybeAutoKillSwitch(trigger, detail = {}) {
    if (!this.config.resilience.autoKillSwitchEnabled) {
      return { triggered: false, reason: "disabled" };
    }

    if (this.store.snapshot().settings.killSwitch) {
      return { triggered: false, reason: "already_on" };
    }

    const failureCount = this.recentRetryableFailures();
    const threshold = this.config.resilience.autoKillSwitchFailureThreshold;
    if (failureCount < threshold) {
      return { triggered: false, reason: "threshold_not_met", failureCount };
    }

    await this.setKillSwitch(
      true,
      `auto:${trigger} failures=${failureCount}/${threshold} window=${this.config.resilience.autoKillSwitchWindowSec}s`,
    );
    await this.pushSystemHealth("AUTO_KILL_SWITCH_ON", {
      trigger,
      failureCount,
      threshold,
      ...detail,
    }, "HIGH");
    return { triggered: true, failureCount, threshold };
  }

  async status() {
    const state = this.store.snapshot();
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        now: nowIso(),
        settings: state.settings,
        openOrders: this.store.getOpenOrders().length,
        recentRiskEvents: state.riskEvents.slice(-5),
        recentSystemHealth: state.systemHealth.slice(-5),
        resilience: {
          autoRetryEnabled: this.config.resilience.autoRetryEnabled,
          autoRetryAttempts: this.config.resilience.autoRetryAttempts,
          autoRetryDelayMs: this.config.resilience.autoRetryDelayMs,
          autoKillSwitchEnabled: this.config.resilience.autoKillSwitchEnabled,
          recentRetryableFailures: this.recentRetryableFailures(),
        },
      },
    };
  }

  async health(options = {}) {
    const state = this.store.snapshot();
    const strict = Boolean(options.strict);
    const checkExchange = Boolean(options.checkExchange);
    const checks = [];

    const addCheck = (name, status, detail = {}) => {
      checks.push({ name, status, detail });
    };

    if (state.settings.killSwitch) {
      addCheck("kill_switch", "FAIL", {
        reason: state.settings.killSwitchReason || "active",
        at: state.settings.killSwitchAt,
      });
    } else {
      addCheck("kill_switch", "PASS", {
        active: false,
      });
    }

    const openOrdersSnapshot = this.store.getOpenOrders();
    const openOrders = openOrdersSnapshot.length;
    if (openOrders > this.config.trading.maxConcurrentOrders) {
      addCheck("open_orders_capacity", "WARN", {
        openOrders,
        maxConcurrentOrders: this.config.trading.maxConcurrentOrders,
      });
    } else {
      addCheck("open_orders_capacity", "PASS", {
        openOrders,
        maxConcurrentOrders: this.config.trading.maxConcurrentOrders,
      });
    }

    const missingExchangeIdOpenOrders = openOrdersSnapshot.filter((order) => !order.paper && !order.exchangeOrderId);
    if (missingExchangeIdOpenOrders.length > 0) {
      addCheck("open_orders_missing_exchange_id", "WARN", {
        count: missingExchangeIdOpenOrders.length,
        sampleOrderIds: missingExchangeIdOpenOrders.slice(0, 5).map((order) => order.id),
      });
    } else {
      addCheck("open_orders_missing_exchange_id", "PASS", {
        count: 0,
      });
    }

    const recentFailures = this.recentRetryableFailures();
    const threshold = this.config.resilience.autoKillSwitchFailureThreshold;
    if (recentFailures >= threshold) {
      addCheck("recent_retryable_failures", "FAIL", {
        recentFailures,
        threshold,
        windowSec: this.config.resilience.autoKillSwitchWindowSec,
      });
    } else if (recentFailures > 0) {
      addCheck("recent_retryable_failures", "WARN", {
        recentFailures,
        threshold,
        windowSec: this.config.resilience.autoKillSwitchWindowSec,
      });
    } else {
      addCheck("recent_retryable_failures", "PASS", {
        recentFailures,
        threshold,
        windowSec: this.config.resilience.autoKillSwitchWindowSec,
      });
    }

    const unknownOrders = state.orders.filter((order) => order.state === "UNKNOWN_SUBMIT");
    const unknownOldestTs = oldestIso(unknownOrders, "createdAt");
    const unknownOldestAgeSec = unknownOldestTs ? Math.max(0, Math.floor((Date.now() - Date.parse(unknownOldestTs)) / 1000)) : 0;
    if (unknownOrders.length === 0) {
      addCheck("unknown_submit_orders", "PASS", {
        count: 0,
        maxAgeSec: this.config.resilience.unknownSubmitMaxAgeSec,
      });
    } else if (unknownOldestAgeSec >= this.config.resilience.unknownSubmitMaxAgeSec) {
      addCheck("unknown_submit_orders", "FAIL", {
        count: unknownOrders.length,
        oldestAgeSec: unknownOldestAgeSec,
        maxAgeSec: this.config.resilience.unknownSubmitMaxAgeSec,
      });
    } else {
      addCheck("unknown_submit_orders", "WARN", {
        count: unknownOrders.length,
        oldestAgeSec: unknownOldestAgeSec,
        maxAgeSec: this.config.resilience.unknownSubmitMaxAgeSec,
      });
    }

    const latestReconcile = latestIso(
      state.systemHealth.filter((event) => event.eventType === "STARTUP_RECONCILE"),
      "eventTs",
    );
    addCheck("startup_reconcile", "PASS", {
      enabled: this.config.runtime.startupReconcile,
      latestRunAt: latestReconcile,
    });

    if (checkExchange) {
      try {
        const ticker = await this.marketData.getMarketTicker(this.config.trading.defaultSymbol);
        addCheck("exchange_public_api", "PASS", {
          symbol: this.config.trading.defaultSymbol,
          sourceUrl: ticker.sourceUrl,
        });
      } catch (error) {
        addCheck("exchange_public_api", "FAIL", {
          symbol: this.config.trading.defaultSymbol,
          reason: error.message,
        });
      }

      if (this.exchangeClient.accessKey && this.exchangeClient.secretKey) {
        try {
          const payload = await this.exchangeClient.getAccounts();
          const accounts = normalizeAccounts(payload);
          addCheck("exchange_private_api", "PASS", {
            accountCount: accounts.length,
          });
        } catch (error) {
          addCheck("exchange_private_api", "FAIL", {
            reason: error.message,
          });
        }
      } else {
        addCheck("exchange_private_api", "WARN", {
          reason: "missing_api_keys",
        });
      }
    }

    const failCount = checks.filter((check) => check.status === "FAIL").length;
    const warnCount = checks.filter((check) => check.status === "WARN").length;
    const summaryStatus = failCount > 0 ? "UNHEALTHY" : warnCount > 0 ? "DEGRADED" : "HEALTHY";
    const payload = {
      now: nowIso(),
      summary: {
        status: summaryStatus,
        strict,
        checkExchange,
        failCount,
        warnCount,
        passCount: checks.filter((check) => check.status === "PASS").length,
      },
      checks,
      context: {
        paperMode: state.settings.paperMode,
        defaultSymbol: this.config.trading.defaultSymbol,
        openOrders,
        recentSystemHealth: state.systemHealth.slice(-10),
      },
    };

    if (failCount === 0 && (!strict || warnCount === 0)) {
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: payload,
      };
    }

    const code = state.settings.killSwitch ? EXIT_CODES.KILL_SWITCH_ACTIVE : EXIT_CODES.RECONCILE_MISMATCH;
    return {
      ok: false,
      code,
      error: {
        message:
          summaryStatus === "DEGRADED" ? "Health check has warnings (strict mode failed)" : "Health check failed",
        type: "SYSTEM_HEALTH_FAILED",
        retryable: summaryStatus === "DEGRADED",
        details: payload,
      },
    };
  }

  async setPaperMode(enabled, reason = null) {
    await this.store.update((state) => {
      state.settings.paperMode = enabled;
      state.settings.paperReason = reason;
      return state;
    });

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        paperMode: enabled,
        reason,
      },
    };
  }

  async setKillSwitch(enabled, reason = null) {
    const openOrdersBefore = this.store.getOpenOrders();
    await this.store.update((state) => {
      state.settings.killSwitch = enabled;
      state.settings.killSwitchAt = nowIso();
      state.settings.killSwitchReason = reason || null;
      return state;
    });

    if (enabled) {
      for (const order of openOrdersBefore) {
        await this.orderManager.cancelOrder(order.id, {
          paperMode: this.paperMode(),
        });
      }
    }

    await this.pushSystemHealth(enabled ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", {
      reason,
      canceledOpenOrders: enabled ? openOrdersBefore.length : 0,
    }, enabled ? "HIGH" : "INFO");

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        killSwitch: enabled,
        reason,
        canceledOpenOrders: enabled ? openOrdersBefore.length : 0,
      },
    };
  }

  async fetchMarket(symbol) {
    try {
      const data = await this.marketData.getMarketTicker(symbol);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data,
      };
    } catch (error) {
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: { message: error.message },
      };
    }
  }

  async fetchCandles({ symbol, interval, count, to }) {
    try {
      const data = await this.marketData.getCandles({
        symbol,
        interval,
        count,
        to,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data,
      };
    } catch (error) {
      if (isCliError(error)) {
        throw error;
      }

      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: { message: error.message },
      };
    }
  }

  async getOrderChance(symbol = null) {
    const resolvedSymbol = String(symbol || this.config.trading.defaultSymbol || "")
      .trim()
      .toUpperCase();
    if (!resolvedSymbol) {
      throw invalidArg("Missing required option --symbol", {
        field: "symbol",
        reason: "missing_required_option",
      });
    }

    try {
      const chance = await this.exchangeClient.getOrderChance({
        symbol: resolvedSymbol,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          symbol: resolvedSymbol,
          market: toBithumbMarket(resolvedSymbol),
          chance,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async listAccounts() {
    try {
      const payload = await this.exchangeClient.getAccounts();
      const accounts = normalizeAccounts(payload);
      const capturedAt = await this.captureBalancesSnapshot("account-list", accounts);

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          capturedAt,
          count: accounts.length,
          accounts,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
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
        capturedAt,
        source,
        items: accounts,
      });

      if (state.balancesSnapshot.length > 200) {
        state.balancesSnapshot = state.balancesSnapshot.slice(-200);
      }

      return state;
    });
    return capturedAt;
  }

  estimateAccountsEquityKrw(accounts = []) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return null;
    }

    let total = 0;
    for (const account of accounts) {
      const currency = String(account?.currency || "").toUpperCase();
      const unitCurrency = String(account?.unitCurrency || "KRW").toUpperCase();
      const balance = Math.max(asNumber(account?.balance, 0), 0);
      const locked = Math.max(asNumber(account?.locked, 0), 0);
      const quantity = balance + locked;
      if (quantity <= 0) {
        continue;
      }

      if (currency === "KRW") {
        total += quantity;
        continue;
      }

      if (unitCurrency === "KRW") {
        const avgBuyPrice = asNumber(account?.avgBuyPrice, NaN);
        if (Number.isFinite(avgBuyPrice) && avgBuyPrice > 0) {
          total += quantity * avgBuyPrice;
        }
      }
    }

    return Number.isFinite(total) ? total : null;
  }

  async resolveDailyPnlContext(baseContext = {}) {
    if (Number.isFinite(asNumber(baseContext.dailyRealizedPnlKrw, NaN))) {
      return baseContext;
    }

    if (this.paperMode()) {
      return baseContext;
    }

    let equityKrw = null;
    try {
      const payload = await this.exchangeClient.getAccounts();
      const accounts = normalizeAccounts(payload);
      await this.captureBalancesSnapshot("risk-context", accounts);
      equityKrw = this.estimateAccountsEquityKrw(accounts);
    } catch {
      const latestSnapshot = this.store.snapshot().balancesSnapshot.at(-1);
      if (latestSnapshot && Array.isArray(latestSnapshot.items)) {
        equityKrw = this.estimateAccountsEquityKrw(latestSnapshot.items);
      }
    }

    if (!Number.isFinite(equityKrw)) {
      return baseContext;
    }

    const tradeDate = dateByTimezone(this.config.runtime.timezone);
    const configuredCapital = asNumber(this.config.trading.initialCapitalKrw, NaN);
    let baseline = null;
    await this.store.update((state) => {
      const saved = state.settings.dailyPnlBaseline;
      const hasValidSaved =
        saved &&
        saved.date === tradeDate &&
        Number.isFinite(asNumber(saved.equityKrw, NaN));

      if (hasValidSaved) {
        baseline = Number(saved.equityKrw);
        return state;
      }

      const nextBaseline = Number.isFinite(configuredCapital) && configuredCapital > 0
        ? configuredCapital
        : equityKrw;

      state.settings.dailyPnlBaseline = {
        date: tradeDate,
        equityKrw: nextBaseline,
        source: Number.isFinite(configuredCapital) && configuredCapital > 0
          ? "initial_capital"
          : "equity_snapshot",
        updatedAt: nowIso(),
      };
      baseline = nextBaseline;
      return state;
    });

    if (!Number.isFinite(baseline)) {
      return baseContext;
    }

    return {
      ...baseContext,
      dailyRealizedPnlKrw: equityKrw - baseline,
      dailyPnlMeta: {
        tradeDate,
        baselineEquityKrw: baseline,
        currentEquityKrw: equityKrw,
      },
    };
  }

  buildOrderInput(options = {}) {
    if (options.amount === null || options.amount === undefined) {
      throw invalidArg("Missing required option --amount", {
        field: "amount",
        reason: "missing_required_option",
      });
    }

    const side = normalizeSide(options.side);
    const type = normalizeOrderType(options.type || "limit");
    const amountKrw = parseAmount(options.amount, "amount");
    let price = null;
    let qty = null;

    if (type === "limit") {
      price = parseAmount(options.price, "price");
      qty = toCeilFixed(amountKrw / price, 8);
    } else if (type === "market") {
      if (side === "buy") {
        // Bithumb market buy uses ord_type=price with KRW notional.
        price = amountKrw;
        qty = 1;
      } else {
        // For amount-based UX, market sell converts amount to volume using reference price.
        price = parseAmount(options.price, "price");
        qty = toCeilFixed(amountKrw / price, 8);
      }
    } else if (type === "price") {
      if (side !== "buy") {
        throw invalidArg("ord_type=price requires side=buy", {
          field: "type",
          input: type,
          reason: "side_mismatch",
        });
      }
      price = amountKrw;
      qty = 1;
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      throw invalidArg(`Invalid amount for price: amount=${amountKrw}, price=${price}`, {
        field: "amount",
        input: amountKrw,
        reason: "amount_too_small_for_price",
      });
    }

    return {
      symbol: String(options.symbol || this.config.trading.defaultSymbol).toUpperCase(),
      side,
      type,
      price,
      qty,
      amountKrw,
      clientOrderKey: options.clientOrderKey || `auto-${uuid()}`,
      strategy: options.strategy || "manual",
      strategyRunId: options.strategyRunId || "manual",
      reason: options.reason || "manual",
    };
  }

  async pickSymbol(options = {}) {
    try {
      const result = await this.symbolSelector.select({
        side: options.side || "buy",
        mode: options.selectMode || null,
        candidates: options.candidates || null,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: result,
      };
    } catch (error) {
      if (isCliError(error)) {
        throw error;
      }

      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
          type: "AUTO_SYMBOL_SELECTION_FAILED",
          retryable: true,
          details: error.details || null,
        },
      };
    }
  }

  isRetryableCode(code) {
    return code === EXIT_CODES.EXCHANGE_RETRYABLE || code === EXIT_CODES.RATE_LIMITED;
  }

  async recoverUnknownSubmitOrder(clientOrderKey, context = {}) {
    const attempts = this.config.resilience.autoRetryEnabled ? this.config.resilience.autoRetryAttempts : 0;
    const delayMs = this.config.resilience.autoRetryDelayMs;
    const unknownMaxAgeMs = this.config.resilience.unknownSubmitMaxAgeSec * 1000;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.sleepFn(delayMs);
      const reconcile = await this.reconcile();
      const current = this.store.findOrderByClientOrderKey(clientOrderKey);
      if (current && current.state !== "UNKNOWN_SUBMIT") {
        await this.pushSystemHealth("AUTO_RETRY_RECOVERED", {
          attempt,
          clientOrderKey,
          state: current.state,
          reconcileOk: reconcile.ok,
          context,
        });
        return {
          recovered: true,
          attempt,
          order: current,
        };
      }
    }

    const current = this.store.findOrderByClientOrderKey(clientOrderKey);
    const unresolvedUnknown = Boolean(current && current.state === "UNKNOWN_SUBMIT");
    if (unresolvedUnknown) {
      await this.pushSystemHealth("UNKNOWN_SUBMIT_UNRESOLVED", {
        clientOrderKey,
        attempts,
        context,
      }, "HIGH");

      const knownTs = Date.parse(current.updatedAt || current.createdAt || "");
      const ageMs = Number.isFinite(knownTs) ? Date.now() - knownTs : 0;
      if (ageMs >= unknownMaxAgeMs) {
        await this.setKillSwitch(true, `auto:unknown_submit_unresolved key=${clientOrderKey}`);
      }
    }

    return {
      recovered: false,
      attempt: attempts,
      order: current || null,
    };
  }

  async placeOrderDirect(options) {
    let autoSelection = null;
    let resolvedSymbol = options.symbol || null;

    if (!resolvedSymbol && options.autoSymbol) {
      const pick = await this.pickSymbol({
        side: options.side,
        selectMode: options.selectMode,
        candidates: options.candidates,
      });
      if (!pick.ok) {
        return pick;
      }

      resolvedSymbol = pick.data.symbol;
      autoSelection = pick.data;
    }

    if (!resolvedSymbol) {
      throw invalidArg("Missing required option --symbol (or use --auto-symbol)", {
        field: "symbol",
        reason: "missing_required_option",
      });
    }

    if (options.clientOrderKey) {
      const existing = this.store.findOrderByClientOrderKey(options.clientOrderKey);
      if (existing) {
        if (existing.state === "UNKNOWN_SUBMIT") {
          const recovery = await this.recoverUnknownSubmitOrder(options.clientOrderKey, {
            source: "idempotent_existing",
          });

          if (recovery.recovered) {
            return {
              ok: true,
              code: EXIT_CODES.OK,
              data: {
                ...recovery.order,
                idempotentHit: true,
                autoRecovered: true,
                retryAttempts: recovery.attempt,
              },
            };
          }

          await this.pushSystemHealth("RETRYABLE_ORDER_FAILURE", {
            code: EXIT_CODES.EXCHANGE_RETRYABLE,
            message: "existing order remains UNKNOWN_SUBMIT",
            clientOrderKey: options.clientOrderKey,
          }, "HIGH");
          await this.maybeAutoKillSwitch("unknown_submit_existing", {
            clientOrderKey: options.clientOrderKey,
          });

          return {
            ok: false,
            code: EXIT_CODES.EXCHANGE_RETRYABLE,
            error: {
              message: "Existing order is still UNKNOWN_SUBMIT after auto-retry",
              details: {
                clientOrderKey: options.clientOrderKey,
                orderId: existing.id,
              },
            },
          };
        }

        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: {
            ...existing,
            idempotentHit: true,
          },
        };
      }
    }

    const order = this.buildOrderInput({
      ...options,
      symbol: resolvedSymbol,
    });
    let dynamicMinOrderNotional = null;
    if (!this.paperMode()) {
      try {
        const chance = await this.exchangeClient.getOrderChance({
          symbol: order.symbol,
        });
        dynamicMinOrderNotional = extractChanceMinTotalKrw(chance, order.side);
      } catch (error) {
        return {
          ok: false,
          code: this.exchangeClient.isRetryableError(error)
            ? EXIT_CODES.EXCHANGE_RETRYABLE
            : EXIT_CODES.EXCHANGE_FATAL,
          error: {
            message: `Failed to fetch order chance before live order: ${error.message}`,
            details: {
              symbol: order.symbol,
              side: order.side,
            },
          },
        };
      }
    }

    const riskContext = await this.resolveDailyPnlContext(options.context || {});
    const risk = this.riskEngine.evaluateOrder(order, {
      ...riskContext,
      aiSelected: Boolean(options.autoSymbol),
      minOrderNotionalKrwOverride: dynamicMinOrderNotional,
    });
    if (!risk.allowed) {
      await this.riskEngine.recordRejection(order, risk);
      return {
        ok: false,
        code: EXIT_CODES.RISK_REJECTED,
        error: {
          message: "Risk policy rejected direct order",
          reasons: risk.reasons,
          metrics: risk.metrics,
        },
      };
    }

    const placed = await this.orderManager.placeOrder(order, {
      paperMode: this.paperMode(),
    });

    if (!placed.ok && this.isRetryableCode(placed.code)) {
      await this.pushSystemHealth("RETRYABLE_ORDER_FAILURE", {
        code: placed.code,
        message: placed.error?.message || "retryable_order_failure",
        clientOrderKey: order.clientOrderKey,
        orderId: placed.error?.orderId || null,
      }, "HIGH");

      const recovery = await this.recoverUnknownSubmitOrder(order.clientOrderKey, {
        source: "direct_place_failure",
      });
      if (recovery.recovered) {
        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: {
            ...recovery.order,
            autoRecovered: true,
            retryAttempts: recovery.attempt,
          },
        };
      }

      await this.maybeAutoKillSwitch("retryable_order_failure", {
        clientOrderKey: order.clientOrderKey,
      });
    }

    if (placed.ok && autoSelection) {
      placed.data = {
        ...placed.data,
        autoSelection,
      };
    }

    if (placed.ok && dynamicMinOrderNotional !== null) {
      placed.data = {
        ...placed.data,
        appliedMinOrderNotionalKrw: risk.metrics.appliedMinOrderNotional,
        exchangeMinOrderNotionalKrw: dynamicMinOrderNotional,
      };
    }

    return placed;
  }

  async resolveUnknownSubmitOrders(options = {}) {
    const { action, nextState } = normalizeUnknownResolveAction(options.action);
    const orderId = options.orderId || null;
    const clientOrderKey = options.clientOrderKey || null;
    const all = Boolean(options.all);
    const reason = options.reason || null;

    if (!all && !orderId && !clientOrderKey) {
      throw invalidArg("order unknown requires --id, --client-order-key, or --all", {
        field: "id|client-order-key|all",
        reason: "missing_target_selector",
      });
    }

    const snapshot = this.store.snapshot();
    const targetIds = new Set();

    if (all) {
      snapshot.orders
        .filter((order) => order.state === "UNKNOWN_SUBMIT")
        .forEach((order) => targetIds.add(order.id));
    }

    if (orderId) {
      const found = snapshot.orders.find((order) => order.id === orderId || order.exchangeOrderId === orderId);
      if (!found) {
        return {
          ok: false,
          code: EXIT_CODES.INVALID_ARGS,
          error: {
            message: `Order not found: ${orderId}`,
          },
        };
      }
      targetIds.add(found.id);
    }

    if (clientOrderKey) {
      const found = snapshot.orders.find((order) => order.clientOrderKey === clientOrderKey);
      if (!found) {
        return {
          ok: false,
          code: EXIT_CODES.INVALID_ARGS,
          error: {
            message: `Order not found for clientOrderKey: ${clientOrderKey}`,
          },
        };
      }
      targetIds.add(found.id);
    }

    if (targetIds.size === 0) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: "No UNKNOWN_SUBMIT orders found for requested selector",
        },
      };
    }

    const resolved = [];
    const skipped = [];
    await this.store.update((state) => {
      for (const id of targetIds) {
        const target = state.orders.find((order) => order.id === id);
        if (!target) {
          skipped.push({
            id,
            reason: "order_not_found",
          });
          continue;
        }

        if (target.state !== "UNKNOWN_SUBMIT") {
          skipped.push({
            id: target.id,
            state: target.state,
            reason: "not_unknown_submit",
          });
          continue;
        }

        target.state = nextState;
        target.updatedAt = nowIso();
        state.orderEvents.push({
          id: uuid(),
          orderId: target.id,
          eventType: nextState,
          payload: {
            source: "manual_unknown_resolve",
            action,
            reason,
          },
          eventTs: nowIso(),
        });

        resolved.push({
          id: target.id,
          clientOrderKey: target.clientOrderKey,
          symbol: target.symbol,
          side: target.side,
          nextState,
        });
      }
      return state;
    });

    if (resolved.length > 0) {
      await this.pushSystemHealth("UNKNOWN_SUBMIT_RESOLVED_MANUAL", {
        action,
        reason,
        resolvedCount: resolved.length,
        ids: resolved.map((item) => item.id),
      }, "HIGH");
    }

    if (resolved.length === 0) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: "No UNKNOWN_SUBMIT orders were resolved",
          details: {
            skipped,
          },
        },
      };
    }

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        action,
        nextState,
        reason,
        resolvedCount: resolved.length,
        skippedCount: skipped.length,
        resolved,
        skipped,
      },
    };
  }

  async cancelOrder(orderId, options = {}) {
    const requestedId = String(orderId || "").trim();
    if (!requestedId) {
      throw invalidArg("Missing required option --id", {
        field: "id",
        reason: "missing_required_option",
      });
    }

    const localOrder = this.store.findOrderById(requestedId);
    if (localOrder) {
      return this.orderManager.cancelOrder(localOrder.id, {
        paperMode: this.paperMode(),
      });
    }

    if (this.paperMode()) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: `Order not found in local store: ${requestedId}`,
        },
      };
    }

    try {
      const response = await this.exchangeClient.cancelOrder({
        exchangeOrderId: requestedId,
        symbol: options.symbol || null,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "exchange-direct",
          exchangeOrderId: requestedId,
          response,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async listOrders(options = {}) {
    const query = normalizeOrderListQuery(options);
    try {
      const payload = await this.exchangeClient.listOrders({
        symbol: query.symbol,
        uuids: query.uuids,
        state: query.state,
        states: query.states,
        page: query.page,
        limit: query.limit,
        orderBy: query.orderBy,
      });
      const orders = asOrderRows(payload);
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          query,
          count: orders.length,
          orders,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  async getOrder(orderId, options = {}) {
    const requestedId = String(orderId || "").trim();
    if (!requestedId) {
      throw invalidArg("Missing required option --id", {
        field: "id",
        reason: "missing_required_option",
      });
    }

    const localOrder = this.store.findOrderById(requestedId) || null;
    if (localOrder?.paper) {
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "local-paper",
          order: localOrder,
        },
      };
    }

    let exchangeOrderId = localOrder?.exchangeOrderId || requestedId;
    const symbol = options.symbol || localOrder?.symbol || null;

    if (localOrder && !localOrder.exchangeOrderId && localOrder.clientOrderKey) {
      try {
        const status = await this.exchangeClient.getOrderStatus({
          exchangeOrderId: null,
          symbol: localOrder.symbol,
          clientOrderKey: localOrder.clientOrderKey,
          orderHint: {
            side: localOrder.side,
            type: localOrder.type,
            price: localOrder.price,
            qty: localOrder.qty,
            createdAt: localOrder.createdAt,
          },
        });
        const resolvedId = pickExchangeOrderId(status);
        if (resolvedId) {
          exchangeOrderId = resolvedId;
          await this.store.update((state) => {
            const target = state.orders.find((item) => item.id === localOrder.id);
            if (target && !target.exchangeOrderId) {
              target.exchangeOrderId = resolvedId;
              target.updatedAt = nowIso();
            }
            return state;
          });
        }
      } catch (error) {
        return {
          ok: false,
          code: this.exchangeClient.isRetryableError(error)
            ? EXIT_CODES.EXCHANGE_RETRYABLE
            : EXIT_CODES.EXCHANGE_FATAL,
          error: {
            message: error.message,
          },
        };
      }
    }

    if (
      !exchangeOrderId ||
      (localOrder && localOrder.id === requestedId && !localOrder.exchangeOrderId && exchangeOrderId === requestedId)
    ) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: { message: `Order has no exchange UUID yet: ${requestedId}` },
      };
    }

    try {
      const order = await this.exchangeClient.getOrder({
        exchangeOrderId,
        symbol,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          source: "exchange",
          localOrderId: localOrder?.id || null,
          exchangeOrderId,
          order,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
        error: {
          message: error.message,
        },
      };
    }
  }

  buildRsiRuntimeConfig() {
    const config = this.config.strategy || {};
    const period = Math.max(2, Number.isFinite(asNumber(config.rsiPeriod, NaN)) ? Math.floor(config.rsiPeriod) : 14);
    const interval = String(config.rsiInterval || "15m").toLowerCase();
    const candleCountRaw = Number.isFinite(asNumber(config.rsiCandleCount, NaN))
      ? Math.floor(config.rsiCandleCount)
      : 100;
    const candleCount = Math.max(period + 1, candleCountRaw);
    const oversold = Number.isFinite(asNumber(config.rsiOversold, NaN)) ? Number(config.rsiOversold) : 30;
    const overbought = Number.isFinite(asNumber(config.rsiOverbought, NaN)) ? Number(config.rsiOverbought) : 70;
    const defaultOrderAmountKrw = Number.isFinite(asNumber(config.defaultOrderAmountKrw, NaN))
      ? Number(config.defaultOrderAmountKrw)
      : 5000;
    return {
      period,
      interval,
      candleCount,
      oversold,
      overbought,
      defaultOrderAmountKrw,
    };
  }

  async finalizeStrategyRun(runId, status, patch = {}) {
    await this.store.update((state) => {
      const target = state.strategyRuns.find((item) => item.id === runId);
      if (!target) {
        return state;
      }
      target.status = status;
      target.endedAt = nowIso();
      Object.assign(target, patch);
      return state;
    });
  }

  async executeRsiStrategy(run) {
    const runtime = this.buildRsiRuntimeConfig();
    try {
      const market = await this.fetchCandles({
        symbol: run.symbol,
        interval: runtime.interval,
        count: runtime.candleCount,
        to: null,
      });
      if (!market.ok) {
        await this.finalizeStrategyRun(run.id, "FAILED", {
          error: market.error || null,
        });
        return market;
      }

      const closes = market.data.candles
        .map((row) => asNumber(row.close, NaN))
        .filter((value) => Number.isFinite(value));
      const latestClose = closes.at(-1) || null;
      const rsiValue = calculateRsi(closes, runtime.period);
      if (!Number.isFinite(rsiValue)) {
        const error = {
          message: `Insufficient candle data for RSI(period=${runtime.period})`,
          type: "STRATEGY_RSI_DATA_INSUFFICIENT",
          retryable: true,
          details: {
            symbol: run.symbol,
            interval: runtime.interval,
            candleCountRequested: runtime.candleCount,
            candleCountReceived: closes.length,
            requiredCandles: runtime.period + 1,
          },
        };
        await this.finalizeStrategyRun(run.id, "FAILED", { error });
        return {
          ok: false,
          code: EXIT_CODES.EXCHANGE_RETRYABLE,
          error,
        };
      }

      const signal = evaluateRsiSignal({
        rsi: rsiValue,
        oversold: runtime.oversold,
        overbought: runtime.overbought,
      });

      const strategyPayload = {
        runId: run.id,
        name: run.name,
        symbol: run.symbol,
        mode: run.mode,
        dryRun: run.dryRun,
        signal,
        rsi: {
          value: rsiValue,
          period: runtime.period,
          interval: runtime.interval,
          candleCount: closes.length,
          latestClose,
          oversold: runtime.oversold,
          overbought: runtime.overbought,
        },
      };

      if (run.dryRun || signal.signal !== "BUY") {
        await this.finalizeStrategyRun(run.id, "COMPLETED", {
          result: strategyPayload,
        });
        return {
          ok: true,
          code: EXIT_CODES.OK,
          data: {
            ...strategyPayload,
            order: null,
          },
        };
      }

      const amount = Number.isFinite(asNumber(run.budget, NaN)) && run.budget > 0
        ? run.budget
        : runtime.defaultOrderAmountKrw;
      const order = await this.placeOrderDirect({
        symbol: run.symbol,
        side: "buy",
        type: "market",
        amount,
        strategy: "rsi",
        strategyRunId: run.id,
        reason: `rsi_signal:${signal.reason}`,
      });

      if (!order.ok) {
        await this.finalizeStrategyRun(run.id, "FAILED", {
          result: strategyPayload,
          error: order.error || null,
        });
        return {
          ...order,
          error: {
            ...(order.error || {}),
            strategy: strategyPayload,
          },
        };
      }

      await this.finalizeStrategyRun(run.id, "COMPLETED", {
        result: strategyPayload,
      });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          ...strategyPayload,
          order: order.data,
        },
      };
    } catch (error) {
      await this.finalizeStrategyRun(run.id, "FAILED", {
        error: {
          message: error.message,
        },
      });
      return {
        ok: false,
        code: EXIT_CODES.EXCHANGE_RETRYABLE,
        error: {
          message: error.message,
          type: "STRATEGY_RUNTIME_FAILED",
          retryable: true,
        },
      };
    }
  }

  async runStrategy({ name = "grid", symbol, dryRun = false, budget = null }) {
    const run = {
      id: uuid(),
      name,
      symbol: symbol || this.config.trading.defaultSymbol,
      mode: this.paperMode() ? "paper" : "live",
      dryRun,
      budget: budget !== null ? Number(budget) : null,
      status: "RUNNING",
      startedAt: nowIso(),
      config: {
        market: toBithumbMarket(symbol || this.config.trading.defaultSymbol),
      },
    };

    await this.store.update((state) => {
      state.strategyRuns.push(run);
      return state;
    });

    if (String(name || "").trim().toLowerCase() === "rsi") {
      return this.executeRsiStrategy(run);
    }

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: run,
    };
  }

  async stopStrategy(name = null) {
    await this.store.update((state) => {
      state.strategyRuns
        .filter((run) => run.status === "RUNNING" && (!name || run.name === name))
        .forEach((run) => {
          run.status = "STOPPED";
          run.endedAt = nowIso();
        });
      return state;
    });

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        stopped: true,
        name,
      },
    };
  }

  async reconcile() {
    return this.stateSync.reconcile();
  }

  async tailLogs() {
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        note: "Use structured JSON logs from stdout/stderr and system log collector.",
      },
    };
  }
}
