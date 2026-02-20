#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, normalizeSymbol } from "../config/defaults.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { logger as defaultLogger } from "../lib/output.js";
import { nowIso } from "../lib/time.js";
import { MarketDataService } from "../core/market-data.js";
import { optimizeRiskManagedMomentum } from "../engine/strategy-optimizer.js";
import { AiSettingsSource } from "./ai-settings.js";

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function loadAiSettingsSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function roundNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function compressCandidate(candidate) {
  if (!candidate) {
    return null;
  }
  return {
    symbol: candidate.symbol,
    strategy: candidate.strategy,
    score: roundNum(candidate.score, 4),
    safe: candidate.safety.safe,
    checks: candidate.safety.checks,
    metrics: {
      totalReturnPct: roundNum(candidate.metrics.totalReturnPct, 4),
      maxDrawdownPct: roundNum(candidate.metrics.maxDrawdownPct, 4),
      sharpe: roundNum(candidate.metrics.sharpe, 4),
      winRatePct: roundNum(candidate.metrics.winRatePct, 4),
      profitFactor: roundNum(candidate.metrics.profitFactor, 4),
      tradeCount: candidate.metrics.tradeCount,
      buyCount: candidate.metrics.buyCount,
      sellCount: candidate.metrics.sellCount,
      turnoverKrw: roundNum(candidate.metrics.turnoverKrw, 2),
      finalEquityKrw: roundNum(candidate.metrics.finalEquityKrw, 2),
    },
  };
}

async function applyBestToAiSettings(config, best, logger) {
  const aiSource = new AiSettingsSource(config, logger);
  await aiSource.init();
  const template = aiSource.defaultTemplate();
  const current = await loadAiSettingsSafe(config.ai.settingsFile);

  const next = {
    ...template,
    ...current,
    version: 1,
    updatedAt: nowIso(),
    execution: {
      ...template.execution,
      ...(current.execution || {}),
      enabled: true,
      symbol: normalizeSymbol(best.symbol),
    },
    strategy: {
      ...template.strategy,
      ...(current.strategy || {}),
      ...best.strategy,
      name: "risk_managed_momentum",
      defaultSymbol: normalizeSymbol(best.symbol),
      candleInterval: config.optimizer.interval,
      candleCount: config.optimizer.candleCount,
    },
    overlay: {
      ...template.overlay,
      ...(current.overlay || {}),
    },
    controls: {
      ...template.controls,
      ...(current.controls || {}),
    },
  };

  await writeJson(config.ai.settingsFile, next);
  return {
    settingsFile: config.ai.settingsFile,
    appliedAt: next.updatedAt,
  };
}

async function fetchCandlesBySymbol(config, logger) {
  const client = new BithumbClient(config, logger);
  const marketData = new MarketDataService(config, client);

  const candlesBySymbol = {};
  const fetchErrors = [];
  for (const symbolRaw of config.optimizer.symbols || []) {
    const symbol = normalizeSymbol(symbolRaw);
    try {
      const response = await marketData.getCandles({
        symbol,
        interval: config.optimizer.interval,
        count: config.optimizer.candleCount,
      });
      candlesBySymbol[symbol] = response.candles || [];
      logger.info("optimizer fetched candles", {
        symbol,
        interval: config.optimizer.interval,
        candleCount: candlesBySymbol[symbol].length,
      });
    } catch (error) {
      fetchErrors.push({
        symbol,
        message: error.message,
      });
      logger.warn("optimizer failed to fetch candles", {
        symbol,
        reason: error.message,
      });
    }
  }
  return { candlesBySymbol, fetchErrors };
}

export async function optimizeAndApplyBest({
  config = null,
  logger = defaultLogger,
  apply = true,
} = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  if (!runtimeConfig.optimizer?.enabled) {
    return {
      ok: false,
      error: { message: "optimizer_disabled" },
    };
  }

  const { candlesBySymbol, fetchErrors } = await fetchCandlesBySymbol(runtimeConfig, logger);
  if (Object.keys(candlesBySymbol).length === 0) {
    return {
      ok: false,
      error: {
        message: "no_candle_data",
        details: fetchErrors,
      },
    };
  }

  const optimization = optimizeRiskManagedMomentum({
    candlesBySymbol,
    strategyBase: {
      autoSellEnabled: runtimeConfig.strategy.autoSellEnabled !== false,
      baseOrderAmountKrw: runtimeConfig.optimizer.baseOrderAmountKrw,
    },
    constraints: {
      maxDrawdownPctLimit: runtimeConfig.optimizer.maxDrawdownPctLimit,
      minTrades: runtimeConfig.optimizer.minTrades,
      minWinRatePct: runtimeConfig.optimizer.minWinRatePct,
      minProfitFactor: runtimeConfig.optimizer.minProfitFactor,
      minReturnPct: runtimeConfig.optimizer.minReturnPct,
    },
    simulation: {
      interval: runtimeConfig.optimizer.interval,
      initialCashKrw: runtimeConfig.optimizer.initialCashKrw,
      baseOrderAmountKrw: runtimeConfig.optimizer.baseOrderAmountKrw,
      minOrderNotionalKrw: runtimeConfig.optimizer.minOrderNotionalKrw,
      feeBps: runtimeConfig.optimizer.feeBps,
      autoSellEnabled: runtimeConfig.strategy.autoSellEnabled !== false,
    },
    gridConfig: {
      momentumLookbacks: runtimeConfig.optimizer.momentumLookbacks,
      volatilityLookbacks: runtimeConfig.optimizer.volatilityLookbacks,
      entryBpsCandidates: runtimeConfig.optimizer.entryBpsCandidates,
      exitBpsCandidates: runtimeConfig.optimizer.exitBpsCandidates,
      targetVolatilityPctCandidates: runtimeConfig.optimizer.targetVolatilityPctCandidates,
      rmMinMultiplierCandidates: runtimeConfig.optimizer.rmMinMultiplierCandidates,
      rmMaxMultiplierCandidates: runtimeConfig.optimizer.rmMaxMultiplierCandidates,
    },
  });

  if (!optimization.best) {
    return {
      ok: false,
      error: { message: "no_candidate" },
    };
  }

  const topN = Math.max(1, runtimeConfig.optimizer.topResults || 10);
  const report = {
    generatedAt: nowIso(),
    source: "optimizer",
    mode: "live",
    interval: runtimeConfig.optimizer.interval,
    candleCount: runtimeConfig.optimizer.candleCount,
    symbols: Object.keys(candlesBySymbol),
    evaluatedSymbols: optimization.evaluatedSymbols,
    evaluatedCandidates: optimization.evaluatedCandidates,
    gridSize: optimization.gridSize,
    constraints: optimization.constraints,
    fetchErrors,
    best: compressCandidate(optimization.best),
    top: optimization.ranked.slice(0, topN).map(compressCandidate),
  };

  await writeJson(runtimeConfig.optimizer.reportFile, report);
  let applied = false;
  let applyResult = null;
  if (apply) {
    applyResult = await applyBestToAiSettings(runtimeConfig, optimization.best, logger);
    applied = true;
  }

  return {
    ok: true,
    data: {
      reportFile: runtimeConfig.optimizer.reportFile,
      applied,
      applyResult,
      best: compressCandidate(optimization.best),
      top: report.top,
    },
  };
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  const config = loadConfig(process.env);
  const result = await optimizeAndApplyBest({
    config,
    logger: defaultLogger,
    apply: config.optimizer.applyToAiSettings !== false,
  });

  if (!result.ok) {
    defaultLogger.error("optimizer failed", {
      message: result.error?.message || "unknown",
      details: result.error?.details || null,
    });
    process.exitCode = 1;
    return;
  }

  defaultLogger.info("optimizer completed", {
    reportFile: result.data.reportFile,
    applied: result.data.applied,
    symbol: result.data.best?.symbol || null,
    returnPct: result.data.best?.metrics?.totalReturnPct ?? null,
    maxDrawdownPct: result.data.best?.metrics?.maxDrawdownPct ?? null,
    strategy: result.data.best?.strategy || null,
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    defaultLogger.error("optimizer fatal error", { message: error.message });
    process.exitCode = 1;
  });
}
