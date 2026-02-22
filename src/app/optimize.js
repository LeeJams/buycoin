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

const AI_RUNTIME_DIRECTIVE_KEYS = {
  execution: [
    "symbol",
    "symbols",
    "orderAmountKrw",
    "maxSymbolsPerWindow",
    "maxOrderAttemptsPerWindow",
  ],
  decision: [
    "mode",
    "allowBuy",
    "allowSell",
    "forceAction",
    "forceAmountKrw",
    "forceOnce",
    "note",
    "symbols",
  ],
  overlay: [
    "multiplier",
    "score",
    "regime",
    "note",
  ],
  controls: [
    "killSwitch",
  ],
};
const AI_RUNTIME_DIRECTIVE_ROOT_KEYS = new Set([
  "version",
  "updatedAt",
  "meta",
  "execution",
  "decision",
  "overlay",
  "controls",
]);
const AI_RUNTIME_DIRECTIVE_FILE_STABILITY_ATTEMPTS = 3;
const AI_RUNTIME_DIRECTIVE_FILE_STABILITY_DELAY_MS = 60;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateRuntimeDirectiveContract(raw = {}, logger, directiveFile) {
  const source = asObject(raw);
  if (!source) {
    logger.warn("optimizer skipped AI runtime directive: invalid root payload", {
      file: directiveFile,
    });
    return false;
  }

  const rawUpdatedAt = parseDirectiveTimestamp(source.updatedAt);
  if (source.updatedAt !== undefined && !Number.isFinite(rawUpdatedAt)) {
    logger.warn("optimizer skipped AI runtime directive: invalid updatedAt", {
      file: directiveFile,
    });
    return false;
  }

  if (source.version !== undefined && source.version !== 1 && source.version !== "1") {
    logger.warn("optimizer ignored unsupported AI_RUNTIME_SETTINGS_FILE.version (expected 1)", {
      file: directiveFile,
      version: source.version,
    });
  }

  const unknownKeys = Object.keys(source).filter((key) => !AI_RUNTIME_DIRECTIVE_ROOT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    logger.warn("optimizer ignored unsupported keys in AI_RUNTIME_SETTINGS_FILE", {
      file: directiveFile,
      ignored: unknownKeys,
    });
  }

  return true;
}

function parseDirectiveTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRuntimeDirectiveStale(raw = {}, config, logger, directiveFile) {
  const maxAgeSec = Number(config?.ai?.runtimeSettingsMaxAgeSec || 0);
  if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
    return false;
  }

  const updatedAt = parseDirectiveTimestamp(raw.updatedAt)
    ?? parseDirectiveTimestamp(raw?.meta?.updatedAt)
    ?? parseDirectiveTimestamp(raw?.meta?.generatedAt)
    ?? parseDirectiveTimestamp(raw?.generatedAt);
  if (!Number.isFinite(updatedAt)) {
    logger.warn("optimizer skipped AI runtime directive: missing/invalid updatedAt while max age policy is enabled", {
      file: directiveFile,
      maxAgeSec,
    });
    return true;
  }

  const ageMs = Date.now() - Number(updatedAt);
  const maxAgeMs = maxAgeSec * 1_000;
  if (ageMs > maxAgeMs) {
    logger.warn("optimizer skipped stale AI runtime directive", {
      file: directiveFile,
      updatedAt: new Date(updatedAt).toISOString(),
      ageSec: Math.floor(ageMs / 1_000),
      maxAgeSec,
    });
    return true;
  }
  if (ageMs < -60_000) {
    logger.warn("optimizer noticed AI runtime directive updatedAt in future", {
      file: directiveFile,
      updatedAt: new Date(updatedAt).toISOString(),
    });
  }
  return false;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pickObject(source, keys) {
  if (!source) {
    return {};
  }
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

function normalizeSymbolArray(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  return Array.from(new Set(
    source
      .map((item) => normalizeSymbol(String(item).trim()))
      .filter(Boolean),
  ));
}

function normalizeAiRuntimeDirective(raw) {
  const source = asObject(raw);
  if (!source) {
    return null;
  }

  const executionSource = asObject(source.execution) || {};
  const directive = {};

  const symbolCandidates = Object.hasOwn(executionSource, "symbols")
    ? executionSource.symbols
    : Object.hasOwn(source, "symbols")
      ? source.symbols
      : null;
  const executionSymbols = normalizeSymbolArray(symbolCandidates);
  const execution = pickObject(executionSource, AI_RUNTIME_DIRECTIVE_KEYS.execution);
  if (executionSymbols.length > 0) {
    execution.symbols = executionSymbols;
    if (!execution.symbol) {
      execution.symbol = executionSymbols[0];
    }
  }
  if (typeof executionSource.symbol === "string") {
    const symbol = normalizeSymbol(executionSource.symbol);
    if (symbol) {
      execution.symbol = symbol;
      if (execution.symbols && execution.symbols.length > 0 && !execution.symbols.includes(symbol)) {
        execution.symbols.unshift(symbol);
      }
    }
  }
  if (Object.keys(execution).length > 0) {
    directive.execution = execution;
  }

  const decision = pickObject(asObject(source.decision), AI_RUNTIME_DIRECTIVE_KEYS.decision);
  if (Object.keys(decision).length > 0) {
    directive.decision = decision;
  }

  const overlay = pickObject(asObject(source.overlay), AI_RUNTIME_DIRECTIVE_KEYS.overlay);
  if (Object.keys(overlay).length > 0) {
    directive.overlay = overlay;
  }

  const controls = pickObject(asObject(source.controls), AI_RUNTIME_DIRECTIVE_KEYS.controls);
  if (Object.keys(controls).length > 0) {
    directive.controls = controls;
  }

  return Object.keys(directive).length > 0 ? directive : null;
}

async function loadAiRuntimeDirective(config, logger) {
  const directiveFile = config.ai?.runtimeSettingsFile;
  if (!directiveFile) {
    return null;
  }

  try {
    const raw = await loadJsonWithWriteStabilityGuard(directiveFile, logger);
    if (!validateRuntimeDirectiveContract(raw, logger, directiveFile)) {
      return null;
    }
    if (isRuntimeDirectiveStale(raw, config, logger, directiveFile)) {
      return null;
    }
    return normalizeAiRuntimeDirective(raw);
  } catch (error) {
    logger.warn("optimizer failed to load external ai runtime file; fallback to existing optimizer symbol sources", {
      file: directiveFile,
      error: error.message,
    });
    return null;
  }
}

async function loadJsonWithWriteStabilityGuard(filePath, logger) {
  const maxAttempts = AI_RUNTIME_DIRECTIVE_FILE_STABILITY_ATTEMPTS;
  const delayMs = AI_RUNTIME_DIRECTIVE_FILE_STABILITY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let beforeStat;
    try {
      beforeStat = await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      logger?.warn("optimizer failed to stat AI runtime directive file; retrying", {
        file: filePath,
        attempt,
        maxAttempts,
        error: error.message,
      });
      await sleep(delayMs);
      continue;
    }

    let rawText;
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      logger?.warn("optimizer retrying AI runtime directive read after read error", {
        file: filePath,
        attempt,
        maxAttempts,
        error: error.message,
      });
      await sleep(delayMs);
      continue;
    }

    let afterStat;
    try {
      afterStat = await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      if (attempt >= maxAttempts) {
        throw error;
      }
      logger?.warn("optimizer retrying AI runtime directive read after second stat error", {
        file: filePath,
        attempt,
        maxAttempts,
        error: error.message,
      });
      await sleep(delayMs);
      continue;
    }

    if (beforeStat.size !== afterStat.size || beforeStat.mtimeMs !== afterStat.mtimeMs) {
      if (attempt >= maxAttempts) {
        logger.warn("optimizer skipped AI runtime directive due unstable write window", {
          file: filePath,
          beforeSize: beforeStat.size,
          afterSize: afterStat.size,
          beforeMtime: new Date(beforeStat.mtimeMs).toISOString(),
          afterMtime: new Date(afterStat.mtimeMs).toISOString(),
        });
        return {};
      }
      logger?.warn("optimizer detected unstable AI runtime directive read; retrying", {
        file: filePath,
        attempt,
        maxAttempts,
      });
      await sleep(delayMs);
      continue;
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      logger?.warn("optimizer retrying AI runtime directive read after JSON parse failure", {
        file: filePath,
        attempt,
        maxAttempts,
        error: error.message,
      });
      await sleep(delayMs);
    }
  }

  return {};
}

async function resolveOptimizerSymbols(config, logger) {
  const fallbackSymbols = Array.isArray(config?.optimizer?.symbols)
    ? config.optimizer.symbols
    : [];

  try {
    const directive = await loadAiRuntimeDirective(config, logger);
    const externalSymbols = Array.isArray(directive?.execution?.symbols)
      ? directive.execution.symbols
      : [];
    if (externalSymbols.length > 0) {
      logger.info("optimizer using external ai runtime symbols", {
        count: externalSymbols.length,
        symbols: externalSymbols,
        source: config.ai?.runtimeSettingsFile || "runtime-directive",
      });
      return externalSymbols;
    }
  } catch (error) {
    logger.warn("optimizer external ai runtime path failed; fallback to ai settings", {
      error: error.message,
    });
  }

  try {
    const aiSource = new AiSettingsSource(config, logger);
    await aiSource.init();
    const aiRuntime = await aiSource.read();
    const aiSymbols = Array.isArray(aiRuntime?.execution?.symbols)
      ? aiRuntime.execution.symbols
      : [];
    const normalized = Array.from(new Set(
      aiSymbols
        .map((item) => normalizeSymbol(item))
        .filter(Boolean),
    ));
    if (normalized.length > 0) {
      logger.info("optimizer using ai-selected symbols", {
        count: normalized.length,
        symbols: normalized,
        source: aiRuntime.source,
      });
      return normalized;
    }
  } catch (error) {
    logger.warn("optimizer failed to load ai symbols; fallback to optimizer config symbols", {
      error: error.message,
    });
  }

  return fallbackSymbols;
}

async function writeJson(filePath, payload) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempFile, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempFile);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        error.cleanupError = cleanupError.message;
      }
    }
    throw error;
  }
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

async function acquireOptimizeLock(lockFile, ttlSec = 900, logger = defaultLogger) {
  const lockPath = lockFile || path.join(process.cwd(), ".trader", "optimize.lock");
  const lockTtlMs = Math.max(1_000, Math.floor(Number(ttlSec) * 1_000));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: nowIso(),
      script: "optimize.js",
    });
    try {
      await fs.writeFile(lockPath, payload, { encoding: "utf8", flag: "wx" });
      return { acquired: true, lockPath };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const lockInfo = await fs.readFile(lockPath, "utf8").catch(() => null);
      let lockMeta = null;
      if (lockInfo) {
        try {
          lockMeta = JSON.parse(lockInfo);
        } catch {
          lockMeta = { malformed: true, raw: lockInfo.slice(0, 120) };
        }
      }

      const lockPid = Number(lockMeta?.pid);
      const lockPidAlive = Number.isFinite(lockPid) && lockPid > 0
        ? (() => {
          try {
            process.kill(lockPid, 0);
            return true;
          } catch (error) {
            if (error.code === "ESRCH") {
              return false;
            }
            if (error.code === "EPERM") {
              return true;
            }
            return false;
          }
        })()
        : null;

      try {
        const stats = await fs.stat(lockPath);
        const stale = lockPidAlive === false || stats.mtimeMs + lockTtlMs < Date.now();
        if (!stale) {
          return {
            acquired: false,
            lockPath,
            reason: "busy",
            lockMeta,
          };
        }
      } catch (statError) {
        if (statError.code === "ENOENT") {
          continue;
        }
        throw statError;
      }

      logger.warn("optimize lock recovered as stale; removing", {
        lockPath,
        lockMeta,
      });
      await fs.unlink(lockPath).catch(() => {});
      continue;
    }
  }
}

async function releaseOptimizeLock(lockPath) {
  if (!lockPath) {
    return;
  }
  try {
    const lockInfo = await fs.readFile(lockPath, "utf8").catch(() => null);
    let lockMeta = null;
    if (lockInfo) {
      try {
        lockMeta = JSON.parse(lockInfo);
      } catch {
        lockMeta = { malformed: true, raw: lockInfo.slice(0, 120) };
      }
    }

    const lockPid = Number(lockMeta?.pid);
    if (!Number.isFinite(lockPid) || lockPid === process.pid) {
      await fs.unlink(lockPath);
      return;
    }

    defaultLogger.warn("optimize lock owner mismatch; skip unlink", {
      lockPath,
      lockMeta,
    });
  } catch {
    // best effort cleanup
  }
}

function compressCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  const walkForward = candidate.walkForward && candidate.walkForward.ok
    ? candidate.walkForward.metrics
    : null;

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
      expectancyKrw: roundNum(candidate.metrics.expectancyKrw, 4),
      expectancyPct: roundNum(candidate.metrics.expectancyPct, 4),
      totalFeeKrw: roundNum(candidate.metrics.totalFeeKrw, 2),
      avgSlippageBps: roundNum(candidate.metrics.avgSlippageBps, 4),
      maxSlippageBps: roundNum(candidate.metrics.maxSlippageBps, 4),
      winRatePct: roundNum(candidate.metrics.winRatePct, 4),
      profitFactor: roundNum(candidate.metrics.profitFactor, 4),
      tradeCount: candidate.metrics.tradeCount,
      buyCount: candidate.metrics.buyCount,
      sellCount: candidate.metrics.sellCount,
      turnoverKrw: roundNum(candidate.metrics.turnoverKrw, 2),
      finalEquityKrw: roundNum(candidate.metrics.finalEquityKrw, 2),
      walkForward: walkForward
        ? {
            foldCount: walkForward.foldCount,
            averageReturnPct: roundNum(walkForward.averageReturnPct, 4),
            averageWinRatePct: roundNum(walkForward.averageWinRatePct, 4),
            averageSlippageBps: roundNum(walkForward.averageSlippageBps, 4),
            maxSlippageBps: roundNum(walkForward.maxSlippageBps, 4),
            passRate: roundNum(walkForward.passRate, 4),
            score: roundNum(walkForward.score, 4),
          }
        : null,
    },
  };
}

async function applyBestToAiSettings(config, best, logger) {
  const aiSource = new AiSettingsSource(config, logger);
  await aiSource.init();
  const template = aiSource.defaultTemplate();
  const current = await loadAiSettingsSafe(config.ai.settingsFile);
  const directive = await loadAiRuntimeDirective(config, logger);
  const directiveExecution = directive?.execution || {};
  const directiveDecision = directive?.decision || {};
  const directiveOverlay = directive?.overlay || {};
  const directiveControls = directive?.controls || {};
  const runId = `${Date.now()}-${process.pid}`;
  const now = Date.now();

  const next = {
    ...template,
    ...current,
    meta: {
      ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
      source: "optimizer",
      approvedBy: "optimize.js",
      runId,
      approvedAt: now,
    },
    version: 1,
    updatedAt: nowIso(),
    execution: {
      ...template.execution,
      ...(current.execution || {}),
      ...directiveExecution,
      enabled: true,
    },
    strategy: {
      ...template.strategy,
      ...(current.strategy || {}),
      ...best.strategy,
      name: "risk_managed_momentum",
      candleInterval: config.optimizer.interval,
      candleCount: config.optimizer.candleCount,
    },
    overlay: {
      ...template.overlay,
      ...(current.overlay || {}),
      ...directiveOverlay,
    },
    decision: {
      ...template.decision,
      ...(current.decision || {}),
      ...directiveDecision,
    },
    controls: {
      ...template.controls,
      ...(current.controls || {}),
      ...directiveControls,
    },
  };

  await writeJson(config.ai.settingsFile, next);
  return {
    settingsFile: config.ai.settingsFile,
    appliedAt: next.updatedAt,
  };
}

async function fetchCandlesBySymbol(config, logger, symbols) {
  const client = new BithumbClient(config, logger);
  const marketData = new MarketDataService(config, client);

  const candlesBySymbol = {};
  const fetchErrors = [];
  for (const symbolRaw of symbols || []) {
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

  const optimizerSymbols = await resolveOptimizerSymbols(runtimeConfig, logger);
  const { candlesBySymbol, fetchErrors } = await fetchCandlesBySymbol(runtimeConfig, logger, optimizerSymbols);
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
      minWalkForwardFoldCount: runtimeConfig.optimizer.walkForwardMinFoldCount,
      minWalkForwardPassRate: runtimeConfig.optimizer.walkForwardMinPassRate,
      minWalkForwardScore: runtimeConfig.optimizer.walkForwardMinScore,
    },
    simulation: {
      interval: runtimeConfig.optimizer.interval,
      initialCashKrw: runtimeConfig.optimizer.initialCashKrw,
      baseOrderAmountKrw: runtimeConfig.optimizer.baseOrderAmountKrw,
      minOrderNotionalKrw: runtimeConfig.optimizer.minOrderNotionalKrw,
      feeBps: runtimeConfig.optimizer.feeBps,
      simulatedSlippageBps: runtimeConfig.optimizer.backtestSlippageBps,
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
    walkForward: {
      enabled: runtimeConfig.optimizer.walkForwardEnabled,
      minScore: runtimeConfig.optimizer.walkForwardMinScore,
      minFoldCount: runtimeConfig.optimizer.walkForwardMinFoldCount,
      minPassRate: runtimeConfig.optimizer.walkForwardMinPassRate,
      trainWindow: runtimeConfig.optimizer.walkForwardTrainWindow,
      testWindow: runtimeConfig.optimizer.walkForwardTestWindow,
      stepWindow: runtimeConfig.optimizer.walkForwardStepWindow,
      maxFolds: runtimeConfig.optimizer.walkForwardMaxFolds,
      scoreWeight: runtimeConfig.optimizer.walkForwardScoreWeight,
    },
  });

  if (!optimization.best) {
    return {
      ok: false,
      error: { message: "no_candidate" },
    };
  }

  const walkForwardEnabled = runtimeConfig.optimizer.walkForwardEnabled === true;
  const walkForwardRows = walkForwardEnabled
    ? optimization.ranked.filter((row) => row?.walkForward !== null && row?.walkForward !== undefined)
    : [];
  const walkForwardOkRows = walkForwardRows.filter((row) => row?.walkForward?.ok === true);
  const walkForwardFoldCounts = walkForwardRows
    .map((row) => Number(row.walkForward?.metrics?.foldCount))
    .filter((value) => Number.isFinite(value));
  const walkForwardPassRates = walkForwardRows
    .map((row) => Number(row.walkForward?.metrics?.passRate))
    .filter((value) => Number.isFinite(value));

  if (optimization.best && optimization.best.safe !== true) {
    logger.warn("optimizer best candidate did not satisfy safety constraints", {
      symbol: optimization.best.symbol,
      checks: optimization.best.safety?.checks || null,
    });
  }
  if (runtimeConfig.optimizer.walkForwardEnabled && optimization.best?.walkForward && !optimization.best.walkForward.ok) {
    logger.warn("optimizer best candidate failed walk-forward validation", {
      symbol: optimization.best.symbol,
      error: optimization.best.walkForward.error || null,
      walkForwardChecks: {
        foldCount: optimization.best.walkForward?.metrics?.foldCount ?? null,
        passRate: optimization.best.walkForward?.metrics?.passRate ?? null,
      },
    });
  }
  if (walkForwardEnabled && walkForwardRows.length === 0) {
    logger.warn("optimizer walk-forward evaluation produced no run results (insufficient fold windows)", {
      symbolCandidates: walkForwardRows.length,
      symbols: optimization.evaluatedSymbols,
      walkForwardConfig: {
        trainWindow: runtimeConfig.optimizer.walkForwardTrainWindow,
        testWindow: runtimeConfig.optimizer.walkForwardTestWindow,
        stepWindow: runtimeConfig.optimizer.walkForwardStepWindow,
        maxFolds: runtimeConfig.optimizer.walkForwardMaxFolds,
      },
    });
  } else if (walkForwardEnabled && walkForwardOkRows.length === 0) {
    logger.warn("optimizer walk-forward validation rejected all candidates", {
      evaluatedRows: walkForwardRows.length,
      symbols: optimization.evaluatedSymbols,
      minFoldCount: runtimeConfig.optimizer.walkForwardMinFoldCount,
      minPassRate: runtimeConfig.optimizer.walkForwardMinPassRate,
    });
  } else if (walkForwardEnabled) {
    logger.info("optimizer walk-forward summary", {
      evaluatedRows: walkForwardRows.length,
      okRows: walkForwardOkRows.length,
      foldCountMin: walkForwardFoldCounts.length > 0 ? Math.min(...walkForwardFoldCounts) : null,
      foldCountMax: walkForwardFoldCounts.length > 0 ? Math.max(...walkForwardFoldCounts) : null,
      passRateMin: walkForwardPassRates.length > 0 ? Math.min(...walkForwardPassRates) : null,
      passRateMax: walkForwardPassRates.length > 0 ? Math.max(...walkForwardPassRates) : null,
    });
  }

  const topN = Math.max(1, runtimeConfig.optimizer.topResults || 10);
  const evaluatedCandidates = Number(optimization.evaluatedCandidates || 0);
  const safeCandidates = Number(Array.isArray(optimization.safeRanked) ? optimization.safeRanked.length : 0);
  const safeRatio = evaluatedCandidates > 0 ? safeCandidates / evaluatedCandidates : 0;
  const report = {
    generatedAt: nowIso(),
    source: "optimizer",
    mode: "live",
    interval: runtimeConfig.optimizer.interval,
    candleCount: runtimeConfig.optimizer.candleCount,
    walkForward: optimization.walkForwardConfig || null,
    symbols: Object.keys(candlesBySymbol),
    evaluatedSymbols: optimization.evaluatedSymbols,
    evaluatedCandidates: optimization.evaluatedCandidates,
    gridSize: optimization.gridSize,
    constraints: optimization.constraints,
    fetchErrors,
    riskSummary: {
      evaluatedSymbols: optimization.evaluatedSymbols,
      evaluatedCandidates,
      safeCandidates,
      safeRatio: roundNum(safeRatio, 4),
      walkForwardEnabled: runtimeConfig.optimizer.walkForwardEnabled,
      walkForwardStats: {
        candidatesWithWalkForward: walkForwardRows.length,
        walkForwardOkCandidates: walkForwardOkRows.length,
        walkForwardFoldCountMin: walkForwardFoldCounts.length > 0 ? Math.min(...walkForwardFoldCounts) : null,
        walkForwardFoldCountMax: walkForwardFoldCounts.length > 0 ? Math.max(...walkForwardFoldCounts) : null,
        walkForwardPassRateMin: walkForwardPassRates.length > 0 ? Math.min(...walkForwardPassRates) : null,
        walkForwardPassRateMax: walkForwardPassRates.length > 0 ? Math.max(...walkForwardPassRates) : null,
        minScore: optimization.constraints?.walkForwardMinScore || -999999,
        minFoldCount: optimization.constraints?.walkForwardMinFoldCount || 0,
        minPassRate: optimization.constraints?.walkForwardMinPassRate || 0,
      },
      walkForwardConfig: {
        minScore: optimization.constraints?.walkForwardMinScore || -999999,
        minFoldCount: optimization.constraints?.walkForwardMinFoldCount || 0,
        minPassRate: optimization.constraints?.walkForwardMinPassRate || 0,
      },
    },
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
      riskSummary: report.riskSummary,
      best: compressCandidate(optimization.best),
      top: report.top,
    },
  };
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  const config = loadConfig(process.env);
  const lock = await acquireOptimizeLock(
    config.optimizer.lockFile,
    config.optimizer.lockTtlSec,
    defaultLogger,
  );
  if (!lock.acquired) {
    defaultLogger.warn("optimizer run skipped by lock guard", {
      reason: lock.reason || "unknown",
      lockPath: lock.lockPath,
      lockMeta: lock.lockMeta || null,
    });
    process.exitCode = 0;
    return;
  }

  try {
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
      safeCandidates: result.data.riskSummary?.safeCandidates ?? null,
      safeRatioPct: result.data.riskSummary?.safeRatio != null
        ? roundNum(result.data.riskSummary.safeRatio * 100, 2)
        : null,
      returnPct: result.data.best?.metrics?.totalReturnPct ?? null,
      maxDrawdownPct: result.data.best?.metrics?.maxDrawdownPct ?? null,
      walkForwardEnabled: result.data.riskSummary?.walkForwardEnabled ?? false,
      strategy: result.data.best?.strategy || null,
    });
  } finally {
    await releaseOptimizeLock(lock.lockPath);
  }

}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    defaultLogger.error("optimizer fatal error", { message: error.message });
    process.exitCode = 1;
  });
}
