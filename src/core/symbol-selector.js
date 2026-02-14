import { normalizeSymbol } from "../config/defaults.js";
import { invalidArg } from "../lib/errors.js";

function parseCandidates(input, fallback) {
  if (Array.isArray(input) && input.length > 0) {
    return input.map((item) => normalizeSymbol(item)).filter(Boolean);
  }

  if (typeof input === "string" && input.trim()) {
    return input
      .split(",")
      .map((item) => normalizeSymbol(item))
      .filter(Boolean);
  }

  return [...fallback];
}

function scoreByMode(mode, metrics) {
  const change = Number.isFinite(metrics.changeRate) ? metrics.changeRate : 0;
  const liquidity = Number.isFinite(metrics.accTradeValue24h) ? metrics.accTradeValue24h : 0;

  if (mode === "volume") {
    return Math.log10(1 + liquidity);
  }

  // momentum mode: prefer positive trend with high liquidity.
  return change * 100 + Math.log10(1 + liquidity);
}

export class SymbolSelector {
  constructor(config, marketData) {
    this.config = config;
    this.marketData = marketData;
  }

  async select({ side = "buy", mode = null, candidates = null } = {}) {
    const normalizedSide = String(side || "buy").toLowerCase();
    if (normalizedSide !== "buy") {
      throw invalidArg("Auto symbol selection supports buy side only", {
        field: "side",
        allowed: ["buy"],
        input: side,
      });
    }

    const pickMode = String(mode || this.config.trading.autoSelectMode || "momentum").toLowerCase();
    if (!["momentum", "volume"].includes(pickMode)) {
      throw invalidArg(`Invalid select mode: ${pickMode}`, {
        field: "select-mode",
        allowed: ["momentum", "volume"],
        input: pickMode,
      });
    }

    const candidateList = parseCandidates(candidates, this.config.trading.autoSelectCandidates);
    if (candidateList.length === 0) {
      throw invalidArg("No candidates available for symbol selection", {
        field: "candidates",
      });
    }

    const ranked = [];
    const failures = [];

    for (const symbol of candidateList) {
      try {
        const ticker = await this.marketData.getMarketTicker(symbol);
        const metrics = this.marketData.extractTickerMetrics(ticker);
        if (!Number.isFinite(metrics.lastPrice) || !Number.isFinite(metrics.accTradeValue24h)) {
          failures.push({
            symbol,
            reason: "missing_ticker_metrics",
          });
          continue;
        }

        ranked.push({
          symbol,
          score: scoreByMode(pickMode, metrics),
          metrics,
        });
      } catch (error) {
        failures.push({
          symbol,
          reason: error.message,
        });
      }
    }

    if (ranked.length === 0) {
      const error = new Error("Auto symbol selection failed: no selectable candidates");
      error.details = {
        side: normalizedSide,
        mode: pickMode,
        failures,
      };
      throw error;
    }

    ranked.sort((a, b) => b.score - a.score);
    const winner = ranked[0];

    return {
      symbol: winner.symbol,
      mode: pickMode,
      reason: `highest_${pickMode}_score`,
      score: winner.score,
      metrics: winner.metrics,
      ranked: ranked.map((item) => ({
        symbol: item.symbol,
        score: item.score,
        changeRate: item.metrics.changeRate,
        accTradeValue24h: item.metrics.accTradeValue24h,
      })),
      failures,
    };
  }
}
