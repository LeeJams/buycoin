import fs from "node:fs/promises";
import path from "node:path";
import { fromBithumbMarket, normalizeSymbol, toBithumbMarket } from "../config/defaults.js";
import { nowIso } from "../lib/time.js";
import { MarketDataService } from "./market-data.js";

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toSymbolArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => normalizeSymbol(item)).filter(Boolean)));
}

function chunkArray(rows = [], size = 40) {
  const chunkSize = Math.max(1, Math.floor(asNumber(size, 40)));
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  return chunks;
}

function normalizeRefreshRange(minRaw, maxRaw, fallbackMin = 1_800, fallbackMax = 3_600) {
  const minParsed = Math.floor(asNumber(minRaw, fallbackMin));
  const maxParsed = Math.floor(asNumber(maxRaw, fallbackMax));
  const minSec = minParsed > 0 ? minParsed : fallbackMin;
  const maxSec = maxParsed > 0 ? maxParsed : fallbackMax;
  return {
    minSec: Math.min(minSec, maxSec),
    maxSec: Math.max(minSec, maxSec),
  };
}

function randomDelaySec(range) {
  if (!range || range.maxSec <= range.minSec) {
    return range?.minSec || 1_800;
  }
  return range.minSec + Math.floor(Math.random() * ((range.maxSec - range.minSec) + 1));
}

function selectTickerPrice(ticker = {}) {
  const keys = ["trade_price", "closing_price", "last", "price"];
  for (const key of keys) {
    const value = asNumber(ticker?.[key], null);
    if (value !== null && value > 0) {
      return value;
    }
  }
  return null;
}

function selectAccTradeValue24h(ticker = {}) {
  const keys = ["acc_trade_price_24h", "acc_trade_value_24h", "acc_trade_value_24H", "acc_trade_price"];
  for (const key of keys) {
    const value = asNumber(ticker?.[key], null);
    if (value !== null && value >= 0) {
      return value;
    }
  }
  return null;
}

function selectChangeRate(ticker = {}) {
  const keys = ["signed_change_rate", "change_rate", "fluctate_rate_24H"];
  for (const key of keys) {
    const value = asNumber(ticker?.[key], null);
    if (value !== null) {
      return Math.abs(value) > 1 ? value / 100 : value;
    }
  }
  return null;
}

export class CuratedMarketUniverse {
  constructor(config, logger, marketData = null) {
    this.config = config;
    this.logger = logger || {
      info() {},
      warn() {},
      error() {},
    };
    this.marketData = marketData || new MarketDataService(config);

    const options = config?.marketUniverse || {};
    this.enabled = Boolean(options.enabled);
    this.quote = String(options.quote || "KRW").trim().toUpperCase();
    this.minAccTradeValue24hKrw = asNumber(options.minAccTradeValue24hKrw, 20_000_000_000);
    this.minPriceKrw = asNumber(options.minPriceKrw, 1);
    this.maxSymbols = Math.max(1, Math.floor(asNumber(options.maxSymbols, 20)));
    this.minBaseAssetLength = Math.max(1, Math.floor(asNumber(options.minBaseAssetLength, 2)));
    this.includeSymbols = toSymbolArray(options.includeSymbols || []);
    this.excludeSymbols = new Set(toSymbolArray(options.excludeSymbols || []));
    this.snapshotFile = options.snapshotFile || null;
    this.tickerChunkSize = Math.max(1, Math.floor(asNumber(options.tickerChunkSize, 40)));
    this.refreshRange = normalizeRefreshRange(options.refreshMinSec, options.refreshMaxSec, 1_800, 3_600);

    this.snapshot = null;
    this.nextRefreshAtMs = 0;
  }

  async init() {
    if (!this.enabled || !this.snapshotFile) {
      return;
    }
    await fs.mkdir(path.dirname(this.snapshotFile), { recursive: true });
  }

  shouldRefresh(nowMs = Date.now()) {
    if (!this.enabled) {
      return false;
    }
    if (!this.snapshot) {
      return true;
    }
    return nowMs >= this.nextRefreshAtMs;
  }

  getAllowedSymbols() {
    if (!this.enabled) {
      return [];
    }
    if (this.snapshot?.symbols && this.snapshot.symbols.length > 0) {
      return this.snapshot.symbols.slice();
    }
    return this.includeSymbols.slice();
  }

  filterSymbols(symbols = []) {
    const normalized = toSymbolArray(symbols);
    if (!this.enabled) {
      return {
        symbols: normalized,
        filteredOut: [],
        allowedCount: normalized.length,
        source: "disabled",
      };
    }

    const allowed = new Set(this.getAllowedSymbols());
    const filtered = [];
    const passed = [];

    for (const symbol of normalized) {
      if (allowed.has(symbol)) {
        passed.push(symbol);
      } else {
        filtered.push(symbol);
      }
    }

    return {
      symbols: passed,
      filteredOut: filtered,
      allowedCount: allowed.size,
      source: this.snapshot?.generatedAt || "empty_universe",
    };
  }

  async maybeRefresh({ force = false, reason = "periodic" } = {}) {
    if (!this.enabled) {
      return {
        ok: true,
        skipped: "disabled",
        data: null,
      };
    }

    if (!force && !this.shouldRefresh()) {
      return {
        ok: true,
        skipped: "not_due",
        data: this.snapshot,
      };
    }

    try {
      return await this.refresh({ reason });
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error.message,
        },
        data: this.snapshot,
      };
    }
  }

  async refresh({ reason = "manual" } = {}) {
    const startedAt = Date.now();
    const marketRows = await this.fetchMarketRows();
    const tickerRows = await this.fetchTickerRows(marketRows.map((row) => row.market));

    const snapshot = this.buildSnapshot({
      reason,
      marketRows,
      tickerRows,
    });

    const nextRefreshSec = randomDelaySec(this.refreshRange);
    this.nextRefreshAtMs = Date.now() + (nextRefreshSec * 1000);
    snapshot.nextRefreshSec = nextRefreshSec;
    snapshot.fetchDurationMs = Math.max(0, Date.now() - startedAt);

    this.snapshot = snapshot;
    await this.writeSnapshot(snapshot);
    return {
      ok: true,
      data: snapshot,
    };
  }

  async fetchMarketRows() {
    const payload = await this.marketData.publicGet("/v1/market/all", { isDetails: true });
    if (!Array.isArray(payload)) {
      throw new Error("invalid market/all payload");
    }

    const quotePrefix = `${this.quote}-`;
    return payload
      .filter((row) => typeof row?.market === "string" && row.market.startsWith(quotePrefix))
      .map((row) => ({
        market: String(row.market).toUpperCase(),
        koreanName: row.korean_name ? String(row.korean_name) : null,
        englishName: row.english_name ? String(row.english_name) : null,
        marketWarning: row.market_warning ? String(row.market_warning).toUpperCase() : "NONE",
      }));
  }

  async fetchTickerRows(markets = []) {
    const uniqueMarkets = Array.from(new Set(
      (Array.isArray(markets) ? markets : [])
        .map((row) => String(row || "").trim().toUpperCase())
        .filter(Boolean),
    ));
    if (uniqueMarkets.length === 0) {
      return [];
    }

    const rows = [];
    const chunks = chunkArray(uniqueMarkets, this.tickerChunkSize);
    for (const batch of chunks) {
      const payload = await this.marketData.publicGet("/v1/ticker", {
        markets: batch.join(","),
      });
      if (Array.isArray(payload)) {
        rows.push(...payload);
      }
    }
    return rows;
  }

  exclusionReason(symbol, marketRow, tickerRow) {
    if (this.excludeSymbols.has(symbol)) {
      return "manual_exclude";
    }

    const baseAsset = symbol.split("_")[0] || "";
    if (baseAsset.length < this.minBaseAssetLength) {
      return "short_base_symbol";
    }

    if (String(marketRow?.marketWarning || "NONE").toUpperCase() !== "NONE") {
      return "market_warning";
    }

    if (!tickerRow || typeof tickerRow !== "object") {
      return "missing_ticker";
    }

    const price = selectTickerPrice(tickerRow);
    if (price === null || price < this.minPriceKrw) {
      return "low_price";
    }

    const accTradeValue24h = selectAccTradeValue24h(tickerRow);
    if (accTradeValue24h === null || accTradeValue24h < this.minAccTradeValue24hKrw) {
      return "low_24h_value";
    }

    return null;
  }

  toCandidate(symbol, marketRow, tickerRow, selectionReason) {
    return {
      symbol,
      market: marketRow.market,
      koreanName: marketRow.koreanName,
      englishName: marketRow.englishName,
      marketWarning: marketRow.marketWarning || "NONE",
      lastPrice: selectTickerPrice(tickerRow),
      changeRate: selectChangeRate(tickerRow),
      accTradeValue24h: selectAccTradeValue24h(tickerRow),
      selectionReason,
    };
  }

  buildSnapshot({ reason, marketRows, tickerRows }) {
    const marketMap = new Map(marketRows.map((row) => [row.market, row]));
    const tickerMap = new Map(
      (Array.isArray(tickerRows) ? tickerRows : [])
        .filter((row) => row && typeof row.market === "string")
        .map((row) => [String(row.market).toUpperCase(), row]),
    );

    const selected = [];
    const selectedSet = new Set();
    const excludedCounts = {};

    for (const includeSymbol of this.includeSymbols) {
      if (this.excludeSymbols.has(includeSymbol) || selectedSet.has(includeSymbol)) {
        continue;
      }
      const includeMarket = toBithumbMarket(includeSymbol);
      const marketRow = marketMap.get(includeMarket);
      if (!marketRow) {
        continue;
      }
      selected.push(this.toCandidate(includeSymbol, marketRow, tickerMap.get(includeMarket), "manual_include"));
      selectedSet.add(includeSymbol);
    }

    const liquidityCandidates = [];
    for (const marketRow of marketRows) {
      const symbol = normalizeSymbol(fromBithumbMarket(marketRow.market));
      if (!symbol || selectedSet.has(symbol)) {
        continue;
      }

      const tickerRow = tickerMap.get(marketRow.market);
      const reasonCode = this.exclusionReason(symbol, marketRow, tickerRow);
      if (reasonCode) {
        excludedCounts[reasonCode] = (excludedCounts[reasonCode] || 0) + 1;
        continue;
      }
      liquidityCandidates.push(this.toCandidate(symbol, marketRow, tickerRow, "liquidity_filter"));
    }

    liquidityCandidates.sort((a, b) => {
      const valueA = asNumber(a.accTradeValue24h, 0);
      const valueB = asNumber(b.accTradeValue24h, 0);
      return valueB - valueA;
    });

    const maxByLiquidity = Math.max(0, this.maxSymbols - selected.length);
    const pickedLiquidity = liquidityCandidates.slice(0, maxByLiquidity);
    const finalCandidates = [...selected, ...pickedLiquidity];
    const symbols = finalCandidates.map((row) => row.symbol);

    return {
      version: 1,
      generatedAt: nowIso(),
      reason,
      quote: this.quote,
      criteria: {
        minAccTradeValue24hKrw: this.minAccTradeValue24hKrw,
        minPriceKrw: this.minPriceKrw,
        maxSymbols: this.maxSymbols,
        includeSymbols: this.includeSymbols,
        excludeSymbols: Array.from(this.excludeSymbols),
        minBaseAssetLength: this.minBaseAssetLength,
      },
      totals: {
        krwMarkets: marketRows.length,
        tickerRows: tickerMap.size,
        selectedSymbols: symbols.length,
      },
      symbols,
      candidates: finalCandidates,
      excludedCounts,
    };
  }

  async writeSnapshot(snapshot) {
    if (!this.snapshotFile) {
      return;
    }
    await fs.mkdir(path.dirname(this.snapshotFile), { recursive: true });
    const tmpFile = `${this.snapshotFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmpFile, this.snapshotFile);
  }
}
