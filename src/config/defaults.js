import path from "node:path";

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
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

function toList(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return [...fallback];
  }

  return String(value)
    .split(",")
    .map((item) => normalizeSymbol(item))
    .filter(Boolean);
}

export function normalizeSymbol(symbol) {
  if (!symbol) {
    return "BTC_KRW";
  }

  const token = symbol.trim().toUpperCase().replace("-", "_");
  return token;
}

function toSymbolNumberMap(value, fallback = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { ...fallback };
  }

  const map = {};
  const entries = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [rawSymbol, rawLimit] = entry.split(":").map((v) => String(v || "").trim());
    if (!rawSymbol || !rawLimit) {
      continue;
    }

    const symbol = normalizeSymbol(rawSymbol);
    const limit = toNumber(rawLimit, NaN);
    if (!Number.isFinite(limit) || limit <= 0) {
      continue;
    }

    map[symbol] = limit;
  }

  return map;
}

export function toBithumbMarket(symbol) {
  const normalized = normalizeSymbol(symbol);
  const [base, quote] = normalized.split("_");

  if (!base || !quote) {
    throw new Error(`Invalid symbol format: ${symbol}`);
  }

  return `${quote}-${base}`;
}

export function loadConfig(env = process.env) {
  return {
    runtime: {
      stateFile: env.TRADER_STATE_FILE || path.join(process.cwd(), ".trader", "state.json"),
      timezone: env.TZ || "Asia/Seoul",
      openClawMode: toBoolean(env.OPENCLAW_AGENT, false),
      stateLockStaleMs: toPositiveInt(env.TRADER_STATE_LOCK_STALE_MS, 30_000),
      startupReconcile: toBoolean(env.TRADER_STARTUP_RECONCILE, true),
    },
    exchange: {
      baseUrl: env.BITHUMB_BASE_URL || "https://api.bithumb.com",
      wsPublicUrl: env.BITHUMB_WS_PUBLIC_URL || "wss://pubwss.bithumb.com/pub/ws",
      wsPrivateUrl: env.BITHUMB_WS_PRIVATE_URL || "wss://pubwss.bithumb.com/pub/ws",
      accessKey: env.BITHUMB_ACCESS_KEY || "",
      secretKey: env.BITHUMB_SECRET_KEY || "",
      timeoutMs: toNumber(env.BITHUMB_TIMEOUT_MS, 5_000),
      maxRetries: toNumber(env.BITHUMB_MAX_RETRIES, 4),
      retryBaseMs: toNumber(env.BITHUMB_RETRY_BASE_MS, 250),
      publicMaxPerSec: toPositiveInt(env.BITHUMB_PUBLIC_MAX_PER_SEC, 150),
      privateMaxPerSec: toPositiveInt(env.BITHUMB_PRIVATE_MAX_PER_SEC, 140),
    },
    trading: {
      defaultPaperMode: toBoolean(env.TRADER_PAPER_MODE, true),
      defaultSymbol: normalizeSymbol(env.TRADER_DEFAULT_SYMBOL || "BTC_KRW"),
      autoSelectMode: String(env.TRADER_AUTO_SELECT_MODE || "momentum").toLowerCase(),
      autoSelectCandidates: toList(env.TRADER_AUTO_SELECT_CANDIDATES, [
        "BTC_KRW",
        "ETH_KRW",
        "XRP_KRW",
        "SOL_KRW",
        "DOGE_KRW",
      ]),
      maxConcurrentOrders: toNumber(env.RISK_MAX_CONCURRENT_ORDERS, 5),
      minOrderNotionalKrw: toNumber(env.RISK_MIN_ORDER_NOTIONAL_KRW, 5_000),
      minOrderNotionalBySymbol: toSymbolNumberMap(env.RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL, {}),
      maxOrderNotionalKrw: toNumber(env.RISK_MAX_ORDER_NOTIONAL_KRW, 300_000),
      dailyLossLimitKrw: toNumber(env.RISK_DAILY_LOSS_LIMIT_KRW, 500_000),
      aiMaxOrderNotionalKrw: toNumber(env.RISK_AI_MAX_ORDER_NOTIONAL_KRW, 100_000),
      aiMaxOrdersPerWindow: toPositiveInt(env.RISK_AI_MAX_ORDERS_PER_WINDOW, 3),
      aiOrderCountWindowSec: toPositiveInt(env.RISK_AI_ORDER_COUNT_WINDOW_SEC, 60),
      aiMaxTotalExposureKrw: toNumber(env.RISK_AI_MAX_TOTAL_EXPOSURE_KRW, 500_000),
      maxSlippageBps: toNumber(env.RISK_MAX_SLIPPAGE_BPS, 30),
      feeBps: toNumber(env.TRADER_FEE_BPS, 5),
    },
    logging: {
      level: env.LOG_LEVEL || "info",
      maskSecrets: toBoolean(env.LOG_MASK_SECRETS, true),
    },
    resilience: {
      autoRetryEnabled: toBoolean(env.TRADER_AUTO_RETRY_ENABLED, true),
      autoRetryAttempts: toPositiveInt(env.TRADER_AUTO_RETRY_ATTEMPTS, 2),
      autoRetryDelayMs: toPositiveInt(env.TRADER_AUTO_RETRY_DELAY_MS, 1_000),
      autoKillSwitchEnabled: toBoolean(env.TRADER_AUTO_KILL_SWITCH_ENABLED, true),
      autoKillSwitchFailureThreshold: toPositiveInt(env.TRADER_AUTO_KILL_SWITCH_FAILURE_THRESHOLD, 3),
      autoKillSwitchWindowSec: toPositiveInt(env.TRADER_AUTO_KILL_SWITCH_WINDOW_SEC, 120),
      unknownSubmitMaxAgeSec: toPositiveInt(env.TRADER_UNKNOWN_SUBMIT_MAX_AGE_SEC, 180),
    },
  };
}
