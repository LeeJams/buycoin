import path from "node:path";

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInt(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toPositiveNumber(value, fallback) {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toCsvList(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
  return String(value)
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function toCsvPositiveInts(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const numbers = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  return numbers.length > 0 ? numbers : fallback.slice();
}

function toCsvPositiveNumbers(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const numbers = raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  return numbers.length > 0 ? numbers : fallback.slice();
}

function toCsvSymbols(value, fallback = []) {
  const raw = toCsvList(value, fallback);
  const normalized = raw.map((item) => normalizeSymbol(item)).filter(Boolean);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback.slice();
}

function toNullablePositiveNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function normalizeSymbol(symbol) {
  if (!symbol) {
    return "BTC_KRW";
  }
  return String(symbol).trim().toUpperCase().replace(/-/g, "_");
}

export function toBithumbMarket(symbol) {
  const normalized = normalizeSymbol(symbol);
  const [base, quote] = normalized.split("_");
  if (!base || !quote) {
    throw new Error(`Invalid symbol format: ${symbol}`);
  }
  return `${quote}-${base}`;
}

export function fromBithumbMarket(market) {
  const token = String(market || "").trim().toUpperCase().replace(/-/g, "_");
  const [quote, base] = token.split("_");
  if (!base || !quote) {
    return normalizeSymbol(market);
  }
  return `${base}_${quote}`;
}

export function loadConfig(env = process.env) {
  const defaultSymbol = normalizeSymbol(env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW");
  const optimizerDefaultSymbols = Array.from(new Set([defaultSymbol, "ETH_KRW", "USDT_KRW"]));
  const universeDefaultIncludes = Array.from(new Set([
    "BTC_KRW",
    "ETH_KRW",
    "XRP_KRW",
    "SOL_KRW",
    "DOGE_KRW",
    "USDT_KRW",
    defaultSymbol,
  ]));

  return {
    runtime: {
      stateFile: env.TRADER_STATE_FILE || path.join(process.cwd(), ".trader", "state.json"),
      overlayFile: env.TRADER_OVERLAY_FILE || path.join(process.cwd(), ".trader", "overlay.json"),
      httpAuditEnabled: toBoolean(env.TRADER_HTTP_AUDIT_ENABLED, false),
      httpAuditFile: env.TRADER_HTTP_AUDIT_FILE || path.join(process.cwd(), ".trader", "http-audit.jsonl"),
      httpAuditMaxBytes: toNonNegativeInt(env.TRADER_HTTP_AUDIT_MAX_BYTES, 10 * 1024 * 1024),
      httpAuditPruneRatio: toNumber(env.TRADER_HTTP_AUDIT_PRUNE_RATIO, 0.7),
      httpAuditCheckEvery: toPositiveInt(env.TRADER_HTTP_AUDIT_CHECK_EVERY, 200),
      timezone: env.TZ || "Asia/Seoul",
      stateLockStaleMs: toPositiveInt(env.TRADER_STATE_LOCK_STALE_MS, 30_000),
      retention: {
        keepLatestOnly: toBoolean(env.TRADER_STATE_KEEP_LATEST_ONLY, true),
        closedOrders: toNonNegativeInt(env.TRADER_RETENTION_CLOSED_ORDERS, 20),
        orders: toPositiveInt(env.TRADER_RETENTION_ORDERS, 400),
        orderEvents: toPositiveInt(env.TRADER_RETENTION_ORDER_EVENTS, 1000),
        strategyRuns: toPositiveInt(env.TRADER_RETENTION_STRATEGY_RUNS, 400),
        balancesSnapshot: toPositiveInt(env.TRADER_RETENTION_BALANCE_SNAPSHOTS, 120),
        fills: toPositiveInt(env.TRADER_RETENTION_FILLS, 1000),
      },
    },
    exchange: {
      baseUrl: env.BITHUMB_BASE_URL || "https://api.bithumb.com",
      wsPublicUrl: env.BITHUMB_WS_PUBLIC_URL || "wss://ws-api.bithumb.com/websocket/v1",
      wsPrivateUrl: env.BITHUMB_WS_PRIVATE_URL || "wss://ws-api.bithumb.com/websocket/v1/private",
      accessKey: env.BITHUMB_ACCESS_KEY || "",
      secretKey: env.BITHUMB_SECRET_KEY || "",
      timeoutMs: toPositiveInt(env.BITHUMB_TIMEOUT_MS, 5_000),
      maxRetries: toPositiveInt(env.BITHUMB_MAX_RETRIES, 4),
      retryBaseMs: toPositiveInt(env.BITHUMB_RETRY_BASE_MS, 250),
      publicMaxPerSec: toPositiveInt(env.BITHUMB_PUBLIC_MAX_PER_SEC, 150),
      privateMaxPerSec: toPositiveInt(env.BITHUMB_PRIVATE_MAX_PER_SEC, 140),
      wsConnectMaxPerSec: toPositiveInt(env.BITHUMB_WS_CONNECT_MAX_PER_SEC, 5),
    },
    strategy: {
      name: String(env.STRATEGY_NAME || "risk_managed_momentum").toLowerCase(),
      defaultSymbol,
      candleInterval: String(env.STRATEGY_CANDLE_INTERVAL || "15m").toLowerCase(),
      candleCount: toPositiveInt(env.STRATEGY_CANDLE_COUNT, 120),
      breakoutLookback: toPositiveInt(env.STRATEGY_BREAKOUT_LOOKBACK, 20),
      breakoutBufferBps: toPositiveNumber(env.STRATEGY_BREAKOUT_BUFFER_BPS, 5),
      momentumLookback: toPositiveInt(env.STRATEGY_MOMENTUM_LOOKBACK, 24),
      volatilityLookback: toPositiveInt(env.STRATEGY_VOLATILITY_LOOKBACK, 72),
      momentumEntryBps: toPositiveNumber(env.STRATEGY_MOMENTUM_ENTRY_BPS, 12),
      momentumExitBps: toPositiveNumber(env.STRATEGY_MOMENTUM_EXIT_BPS, 8),
      targetVolatilityPct: toPositiveNumber(env.STRATEGY_TARGET_VOLATILITY_PCT, 0.6),
      riskManagedMinMultiplier: toPositiveNumber(env.STRATEGY_RM_MIN_MULTIPLIER, 0.6),
      riskManagedMaxMultiplier: toPositiveNumber(env.STRATEGY_RM_MAX_MULTIPLIER, 2.2),
      autoSellEnabled: toBoolean(env.STRATEGY_AUTO_SELL_ENABLED, true),
      sellAllOnExit: toBoolean(env.STRATEGY_SELL_ALL_ON_EXIT, true),
      sellAllQtyPrecision: toPositiveInt(env.STRATEGY_SELL_ALL_QTY_PRECISION, 8),
      baseOrderAmountKrw: toPositiveNumber(env.STRATEGY_BASE_ORDER_AMOUNT_KRW, 5_000),
    },
    optimizer: {
      enabled: toBoolean(env.OPTIMIZER_ENABLED, true),
      applyOnStart: toBoolean(env.OPTIMIZER_APPLY_ON_START, false),
      applyToAiSettings: toBoolean(env.OPTIMIZER_APPLY_TO_AI_SETTINGS, true),
      reoptEnabled: toBoolean(env.OPTIMIZER_REOPT_ENABLED, true),
      reoptIntervalSec: toPositiveInt(env.OPTIMIZER_REOPT_INTERVAL_SEC, 3600),
      reportFile: env.OPTIMIZER_REPORT_FILE || path.join(process.cwd(), ".trader", "optimizer-report.json"),
      symbols: toCsvSymbols(env.OPTIMIZER_SYMBOLS, optimizerDefaultSymbols),
      interval: String(env.OPTIMIZER_INTERVAL || env.STRATEGY_CANDLE_INTERVAL || "15m").toLowerCase(),
      candleCount: toPositiveInt(env.OPTIMIZER_CANDLE_COUNT, 200),
      initialCashKrw: toPositiveNumber(
        env.OPTIMIZER_INITIAL_CASH_KRW,
        1_000_000,
      ),
      baseOrderAmountKrw: toPositiveNumber(
        env.OPTIMIZER_BASE_ORDER_AMOUNT_KRW,
        toPositiveNumber(env.EXECUTION_ORDER_AMOUNT_KRW, 5_000),
      ),
      minOrderNotionalKrw: toPositiveNumber(
        env.OPTIMIZER_MIN_ORDER_NOTIONAL_KRW,
        toPositiveNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 5_000),
      ),
      feeBps: toPositiveNumber(env.OPTIMIZER_FEE_BPS, 5),
      maxDrawdownPctLimit: toPositiveNumber(env.OPTIMIZER_MAX_DRAWDOWN_PCT, 10),
      minTrades: toNonNegativeInt(env.OPTIMIZER_MIN_TRADES, 4),
      minWinRatePct: toPositiveNumber(env.OPTIMIZER_MIN_WIN_RATE_PCT, 45),
      minProfitFactor: toPositiveNumber(env.OPTIMIZER_MIN_PROFIT_FACTOR, 1.05),
      minReturnPct: toNumber(env.OPTIMIZER_MIN_RETURN_PCT, 0),
      topResults: toPositiveInt(env.OPTIMIZER_TOP_RESULTS, 10),
      momentumLookbacks: toCsvPositiveInts(env.OPTIMIZER_MOMENTUM_LOOKBACKS, [24, 36, 48, 72]),
      volatilityLookbacks: toCsvPositiveInts(env.OPTIMIZER_VOLATILITY_LOOKBACKS, [72, 96, 120, 144]),
      entryBpsCandidates: toCsvPositiveNumbers(env.OPTIMIZER_ENTRY_BPS, [10, 16, 24, 32]),
      exitBpsCandidates: toCsvPositiveNumbers(env.OPTIMIZER_EXIT_BPS, [6, 10, 14, 20]),
      targetVolatilityPctCandidates: toCsvPositiveNumbers(env.OPTIMIZER_TARGET_VOLATILITY_PCT, [0.35, 0.5]),
      rmMinMultiplierCandidates: toCsvPositiveNumbers(env.OPTIMIZER_RM_MIN_MULTIPLIER, [0.4]),
      rmMaxMultiplierCandidates: toCsvPositiveNumbers(env.OPTIMIZER_RM_MAX_MULTIPLIER, [1.6, 1.8]),
    },
    risk: {
      minOrderNotionalKrw: toPositiveNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 5_000),
      maxOrderNotionalKrw: toPositiveNumber(env.RISK_MAX_ORDER_NOTIONAL_KRW, 300_000),
      maxOpenOrders: toPositiveInt(env.RISK_MAX_OPEN_ORDERS, 5),
      maxExposureKrw: toPositiveNumber(env.RISK_MAX_EXPOSURE_KRW, 2_000_000),
      maxDailyLossKrw: toPositiveNumber(env.RISK_MAX_DAILY_LOSS_KRW, 500_000),
      initialCapitalKrw: toNullablePositiveNumber(env.TRADER_INITIAL_CAPITAL_KRW),
    },
    overlay: {
      enabled: toBoolean(env.OVERLAY_ENABLED, true),
      timeoutMs: toPositiveInt(env.OVERLAY_TIMEOUT_MS, 500),
      defaultMultiplier: toPositiveNumber(env.OVERLAY_DEFAULT_MULTIPLIER, 1),
      fallbackMultiplier: toPositiveNumber(env.OVERLAY_FALLBACK_MULTIPLIER, 1),
      minMultiplier: toPositiveNumber(env.OVERLAY_MIN_MULTIPLIER, 0.2),
      maxMultiplier: toPositiveNumber(env.OVERLAY_MAX_MULTIPLIER, 1.5),
      maxStalenessSec: toPositiveInt(env.OVERLAY_MAX_STALENESS_SEC, 600),
    },
    ai: {
      enabled: toBoolean(env.AI_SETTINGS_ENABLED, true),
      settingsFile: env.AI_SETTINGS_FILE || path.join(process.cwd(), ".trader", "ai-settings.json"),
      applyOverlay: toBoolean(env.AI_SETTINGS_APPLY_OVERLAY, true),
      applyKillSwitch: toBoolean(env.AI_SETTINGS_APPLY_KILL_SWITCH, true),
      refreshMinSec: toPositiveInt(env.AI_SETTINGS_REFRESH_MIN_SEC, 1_800),
      refreshMaxSec: toPositiveInt(env.AI_SETTINGS_REFRESH_MAX_SEC, 3_600),
    },
    marketUniverse: {
      enabled: toBoolean(env.MARKET_UNIVERSE_ENABLED, true),
      quote: String(env.MARKET_UNIVERSE_QUOTE || "KRW").trim().toUpperCase(),
      minAccTradeValue24hKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_ACC_TRADE_VALUE_24H_KRW, 20_000_000_000),
      minPriceKrw: toPositiveNumber(env.MARKET_UNIVERSE_MIN_PRICE_KRW, 1),
      maxSymbols: toPositiveInt(env.MARKET_UNIVERSE_MAX_SYMBOLS, 20),
      includeSymbols: toCsvSymbols(env.MARKET_UNIVERSE_INCLUDE_SYMBOLS, universeDefaultIncludes),
      excludeSymbols: toCsvSymbols(env.MARKET_UNIVERSE_EXCLUDE_SYMBOLS, []),
      minBaseAssetLength: toPositiveInt(env.MARKET_UNIVERSE_MIN_BASE_ASSET_LENGTH, 2),
      refreshMinSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MIN_SEC, 1_800),
      refreshMaxSec: toPositiveInt(env.MARKET_UNIVERSE_REFRESH_MAX_SEC, 3_600),
      snapshotFile: env.MARKET_UNIVERSE_FILE || path.join(process.cwd(), ".trader", "market-universe.json"),
      tickerChunkSize: toPositiveInt(env.MARKET_UNIVERSE_TICKER_CHUNK_SIZE, 40),
    },
    execution: {
      enabled: toBoolean(env.EXECUTION_ENABLED, true),
      symbol: normalizeSymbol(env.EXECUTION_SYMBOL || env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW"),
      symbols: toCsvSymbols(
        env.EXECUTION_SYMBOLS,
        [normalizeSymbol(env.EXECUTION_SYMBOL || env.STRATEGY_SYMBOL || env.TRADER_DEFAULT_SYMBOL || "BTC_KRW")],
      ),
      orderAmountKrw: toPositiveNumber(
        env.EXECUTION_ORDER_AMOUNT_KRW,
        toPositiveNumber(env.STRATEGY_BASE_ORDER_AMOUNT_KRW, 5_000),
      ),
      windowSec: toPositiveInt(env.EXECUTION_WINDOW_SEC, 300),
      cooldownSec: toPositiveInt(env.EXECUTION_COOLDOWN_SEC, 30),
      dryRun: toBoolean(env.EXECUTION_DRY_RUN, false),
      restartDelayMs: toPositiveInt(env.EXECUTION_RESTART_DELAY_MS, 1_000),
      maxWindows: toNonNegativeInt(env.EXECUTION_MAX_WINDOWS, 0),
      logOnlyOnActivity: toBoolean(env.EXECUTION_LOG_ONLY_ON_ACTIVITY, true),
      heartbeatWindows: toPositiveInt(env.EXECUTION_LOG_HEARTBEAT_WINDOWS, 12),
    },
  };
}
