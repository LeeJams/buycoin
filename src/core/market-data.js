import { toBithumbMarket } from "../config/defaults.js";
import { invalidArg } from "../lib/errors.js";

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChangeRate(value) {
  const num = asNumber(value);
  if (num === null) {
    return null;
  }

  // Legacy payload often uses percent units.
  if (Math.abs(num) > 1) {
    return num / 100;
  }

  return num;
}

export function extractTickerMetrics(payload) {
  // Upbit-style array response: [{ trade_price, signed_change_rate, acc_trade_price_24h, ... }]
  if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === "object") {
    const row = payload[0];
    return {
      lastPrice: asNumber(row.trade_price ?? row.closing_price),
      changeRate: normalizeChangeRate(row.signed_change_rate ?? row.change_rate),
      accTradeValue24h: asNumber(row.acc_trade_price_24h ?? row.acc_trade_value_24h),
    };
  }

  // Legacy Bithumb public payload: { status: "0000", data: { ... } }
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    const row = payload.data;
    return {
      lastPrice: asNumber(row.closing_price ?? row.trade_price),
      changeRate: normalizeChangeRate(row.fluctate_rate_24H ?? row.signed_change_rate),
      accTradeValue24h: asNumber(row.acc_trade_value_24H ?? row.acc_trade_price_24h ?? row.acc_trade_value_24h),
    };
  }

  if (payload && typeof payload === "object") {
    return {
      lastPrice: asNumber(payload.trade_price ?? payload.closing_price),
      changeRate: normalizeChangeRate(payload.signed_change_rate ?? payload.fluctate_rate_24H),
      accTradeValue24h: asNumber(payload.acc_trade_price_24h ?? payload.acc_trade_value_24h ?? payload.acc_trade_value_24H),
    };
  }

  return {
    lastPrice: null,
    changeRate: null,
    accTradeValue24h: null,
  };
}

const CANDLE_INTERVALS = Object.freeze({
  "1m": "/v1/candles/minutes/1",
  "3m": "/v1/candles/minutes/3",
  "5m": "/v1/candles/minutes/5",
  "10m": "/v1/candles/minutes/10",
  "15m": "/v1/candles/minutes/15",
  "30m": "/v1/candles/minutes/30",
  "60m": "/v1/candles/minutes/60",
  "240m": "/v1/candles/minutes/240",
  day: "/v1/candles/days",
  week: "/v1/candles/weeks",
  month: "/v1/candles/months",
});

function normalizeInterval(interval) {
  const normalized = String(interval || "1m").trim().toLowerCase();
  if (!(normalized in CANDLE_INTERVALS)) {
    throw invalidArg(`Unsupported interval: ${interval}`, {
      field: "interval",
      allowed: Object.keys(CANDLE_INTERVALS),
      input: interval,
    });
  }

  return normalized;
}

function normalizeCandleRows(rows, symbol, interval) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => ({
    symbol: symbol.toUpperCase(),
    market: row.market || toBithumbMarket(symbol),
    interval,
    open: asNumber(row.opening_price),
    high: asNumber(row.high_price),
    low: asNumber(row.low_price),
    close: asNumber(row.trade_price),
    volume: asNumber(row.candle_acc_trade_volume),
    value: asNumber(row.candle_acc_trade_price),
    candleTimeUtc: row.candle_date_time_utc || null,
    candleTimeKst: row.candle_date_time_kst || null,
    timestamp: asNumber(row.timestamp),
    unit: asNumber(row.unit),
    firstDayOfPeriod: row.first_day_of_period || null,
    raw: row,
  }));
}

export class MarketDataService {
  constructor(config, exchangeClient = null) {
    this.config = config;
    this.exchangeClient = exchangeClient;
  }

  async publicGet(path, query = {}) {
    if (this.exchangeClient && typeof this.exchangeClient.withRetry === "function") {
      return this.exchangeClient.withRetry({
        method: "GET",
        path,
        query,
        requiresAuth: false,
      });
    }

    const queryString = new URLSearchParams(
      Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ).toString();
    const url = queryString
      ? `${this.config.exchange.baseUrl}${path}?${queryString}`
      : `${this.config.exchange.baseUrl}${path}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return safeJson(response);
  }

  async getMarketTicker(symbol) {
    const market = toBithumbMarket(symbol);
    const legacy = symbol.toUpperCase();
    const candidates = [{ path: "/v1/ticker", query: { markets: market } }, { path: `/public/ticker/${legacy}`, query: {} }];

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const payload = await this.publicGet(candidate.path, candidate.query);
        const queryString = new URLSearchParams(candidate.query || {}).toString();
        const sourceUrl = queryString
          ? `${this.config.exchange.baseUrl}${candidate.path}?${queryString}`
          : `${this.config.exchange.baseUrl}${candidate.path}`;
        return {
          symbol: symbol.toUpperCase(),
          market,
          sourceUrl,
          payload,
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Unable to fetch market ticker");
  }

  extractTickerMetrics(tickerResponse) {
    return extractTickerMetrics(tickerResponse?.payload);
  }

  async getCandles({ symbol, interval = "1m", count = 200, to = null } = {}) {
    const normalizedSymbol = String(symbol || "").toUpperCase();
    if (!normalizedSymbol) {
      throw invalidArg("Missing required option --symbol", {
        field: "symbol",
        reason: "missing_required_option",
      });
    }

    const normalizedInterval = normalizeInterval(interval);
    const path = CANDLE_INTERVALS[normalizedInterval];
    const normalizedCount = Number(count);
    if (!Number.isFinite(normalizedCount) || !Number.isInteger(normalizedCount) || normalizedCount <= 0 || normalizedCount > 200) {
      throw invalidArg("Invalid count: must be integer 1..200", {
        field: "count",
        input: count,
        reason: "must_be_1_to_200",
      });
    }

    const query = {
      market: toBithumbMarket(normalizedSymbol),
      count: normalizedCount,
      to: to || undefined,
    };

    const payload = await this.publicGet(path, query);
    return {
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      count: normalizedCount,
      to: to || null,
      sourceUrl: `${this.config.exchange.baseUrl}${path}`,
      candles: normalizeCandleRows(payload, normalizedSymbol, normalizedInterval),
      raw: payload,
    };
  }
}
