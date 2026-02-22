#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, normalizeSymbol } from "../config/defaults.js";
import { EXIT_CODES, codeName } from "../config/exit-codes.js";
import { CuratedMarketUniverse } from "../core/market-universe.js";
import { TradingSystem } from "../core/trading-system.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { HttpAuditLog } from "../lib/http-audit-log.js";
import { logger } from "../lib/output.js";
import { AiSettingsSource } from "./ai-settings.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundNum(value, digits = 4) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asPositiveInt(value, fallback = null) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function asNonNegativeInt(value, fallback = null) {
  const parsed = asNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function evaluateExecutionKpiGuard(kpi = {}, config = {}, options = {}) {
  if (options.dryRun === true) {
    return {
      enabled: false,
      triggered: false,
      reasons: ["dry_run_skipped"],
      metrics: null,
      thresholds: null,
    };
  }

  if (!config || config.kpiGuardEnabled !== true) {
    return {
      enabled: false,
      triggered: false,
      reasons: [],
      metrics: null,
      thresholds: null,
    };
  }

  const minTrades = asNumber(config.kpiGuardMinTrades, 0);
  const minWinRatePct = asNumber(config.kpiGuardMinWinRatePct, null);
  const maxSlippageBps = asNumber(config.kpiGuardMaxAbsSlippageBps, null);
  const minExpectancyKrw = asNumber(config.kpiGuardMinExpectancyKrw, null);

  const realized = kpi?.realized || {};
  const fills = kpi?.fills || {};
  const metrics = {
    tradeCount: asNumber(realized.tradeCount, 0) ?? 0,
    winRatePct: asNumber(realized.winRatePct, null),
    expectancyKrw: asNumber(realized.expectancyKrw, null),
    avgAbsSlippageBps: asNumber(fills.avgAbsSlippageBps, null),
  };

  if (Number.isFinite(minTrades) && metrics.tradeCount < minTrades) {
    return {
      enabled: true,
      triggered: false,
      reasons: ["insufficient_trades_for_guard"],
      metrics,
      thresholds: {
        minTrades,
        minWinRatePct,
        maxSlippageBps,
        minExpectancyKrw,
      },
    };
  }

  const reasons = [];
  if (Number.isFinite(minWinRatePct) && Number.isFinite(metrics.winRatePct) && metrics.winRatePct < minWinRatePct) {
    reasons.push(`low_win_rate:${metrics.winRatePct.toFixed(4)} < ${minWinRatePct}`);
  }
  if (Number.isFinite(minExpectancyKrw) && Number.isFinite(metrics.expectancyKrw) && metrics.expectancyKrw < minExpectancyKrw) {
    reasons.push(`low_expectancy:${metrics.expectancyKrw.toFixed(2)} < ${minExpectancyKrw}`);
  }
  if (Number.isFinite(maxSlippageBps) && Number.isFinite(metrics.avgAbsSlippageBps)
    && metrics.avgAbsSlippageBps > maxSlippageBps) {
    reasons.push(`high_slippage:${metrics.avgAbsSlippageBps.toFixed(4)} > ${maxSlippageBps}`);
  }

  return {
    enabled: true,
    triggered: reasons.length > 0,
    reasons,
    metrics,
    thresholds: {
      minTrades,
      minWinRatePct,
      maxSlippageBps,
      minExpectancyKrw,
    },
  };
}

function normalizeSymbolList(symbols, fallbackSymbol = "BTC_KRW") {
  let source = [];
  if (Array.isArray(symbols)) {
    source = symbols;
  } else if (typeof symbols === "string") {
    source = symbols.split(",");
  }

  const normalized = source
    .map((item) => normalizeSymbol(String(item || "").trim()))
    .filter(Boolean);

  const unique = Array.from(new Set(normalized));
  if (unique.length > 0) {
    return unique;
  }
  return [normalizeSymbol(fallbackSymbol)];
}

function isOptimizerApprovedAiRuntime(aiRuntime = {}, requireOptimizerApproval = false) {
  if (!requireOptimizerApproval) {
    return true;
  }
  const meta = aiRuntime?.meta;
  return meta
    && meta.source === "optimizer"
    && typeof meta.approvedBy === "string"
    && meta.approvedBy.length > 0
    && Number.isFinite(Number(meta.approvedAt))
    && Number(meta.approvedAt) > 0;
}

function getRuntimeApprovalState(aiRuntime = {}, requireOptimizerApproval = false) {
  return {
    require: Boolean(requireOptimizerApproval),
    approved: isOptimizerApprovedAiRuntime(aiRuntime, requireOptimizerApproval),
  };
}

function resolveDecisionForSymbol(decision, symbol) {
  if (!decision || typeof decision !== "object") {
    return null;
  }

  const base = {
    mode: decision.mode,
    allowBuy: decision.allowBuy,
    allowSell: decision.allowSell,
    forceAction: decision.forceAction,
    forceAmountKrw: decision.forceAmountKrw,
    forceOnce: decision.forceOnce,
    note: decision.note,
  };

  const normalizedSymbol = normalizeSymbol(symbol);
  const perSymbol = decision.symbols && typeof decision.symbols === "object"
    ? decision.symbols[normalizedSymbol]
    : null;

  if (!perSymbol || typeof perSymbol !== "object") {
    return base;
  }

  return {
    ...base,
    ...perSymbol,
  };
}

function normalizeAiRefreshRange(aiConfig = {}) {
  const fixedRaw = Number(aiConfig?.refreshFixedSec);
  const fixedSec = Number.isFinite(fixedRaw) && fixedRaw > 0 ? Math.floor(fixedRaw) : 0;
  if (fixedSec > 0) {
    return {
      minSec: fixedSec,
      maxSec: fixedSec,
    };
  }

  const minRaw = Number(aiConfig?.refreshMinSec);
  const maxRaw = Number(aiConfig?.refreshMaxSec);
  const minSec = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 1_800;
  const maxSec = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 3_600;
  return {
    minSec: Math.min(minSec, maxSec),
    maxSec: Math.max(minSec, maxSec),
  };
}

function nextAiRefreshDelay(range) {
  if (!range || range.maxSec <= range.minSec) {
    return {
      sec: range?.minSec || 1_800,
      ms: (range?.minSec || 1_800) * 1_000,
    };
  }

  const sec = range.minSec + Math.floor(Math.random() * ((range.maxSec - range.minSec) + 1));
  return {
    sec,
    ms: sec * 1_000,
  };
}

function aggregateWindowResults(results = []) {
  const successful = [];
  const failed = [];

  for (const row of results) {
    if (row?.result?.ok) {
      successful.push(row);
    } else {
      failed.push(row);
    }
  }

  const totals = successful.reduce(
    (acc, row) => {
      const data = row.result?.data || {};
      acc.tickCount += Number(data.tickCount || 0);
      acc.buySignals += Number(data.buySignals || 0);
      acc.sellSignals += Number(data.sellSignals || 0);
      acc.attemptedOrders += Number(data.attemptedOrders || 0);
      acc.successfulOrders += Number(data.successfulOrders || 0);
      return acc;
    },
    {
      tickCount: 0,
      buySignals: 0,
      sellSignals: 0,
      attemptedOrders: 0,
      successfulOrders: 0,
    },
  );

  return {
    successful,
    failed,
    totals,
  };
}

function isRetryableFailureRow(row) {
  return row?.result?.code === EXIT_CODES.EXCHANGE_RETRYABLE;
}

function calculateWindowDelayMs(executionConfig, streamFailureStreak = 0) {
  const baseDelayMs = Number.isFinite(Number(executionConfig?.restartDelayMs))
    ? Math.max(0, Math.floor(Number(executionConfig.restartDelayMs)))
    : 1_000;
  const threshold = Number.isFinite(Number(executionConfig?.streamFailureRetryThreshold))
    ? Math.max(1, Math.floor(Number(executionConfig.streamFailureRetryThreshold)))
    : 1;
  if (streamFailureStreak < threshold) {
    return baseDelayMs;
  }

  const baseBackoffMs = Number.isFinite(Number(executionConfig?.streamFailureBackoffBaseMs))
    ? Math.max(baseDelayMs, Math.floor(Number(executionConfig.streamFailureBackoffBaseMs)))
    : Math.max(2_000, baseDelayMs);
  const maxBackoffMs = Number.isFinite(Number(executionConfig?.streamFailureBackoffMaxMs))
    ? Math.max(baseBackoffMs, Math.floor(Number(executionConfig.streamFailureBackoffMaxMs)))
    : baseBackoffMs * 16;

  const exponent = Math.min(streamFailureStreak - threshold + 1, 10);
  return Math.min(maxBackoffMs, Math.max(baseBackoffMs, baseBackoffMs * 2 ** (exponent - 1)));
}

function summarizeExecutionKpiSamples(samples = []) {
  const totals = {
    sampleCount: 0,
    fillCount: 0,
    buyFillCount: 0,
    sellFillCount: 0,
    totalAmountKrw: 0,
    totalFeeKrw: 0,
    totalSignedSlippageBps: 0,
    totalAbsSlippageBps: 0,
    slippageSampleCount: 0,
    realizedTradeCount: 0,
    realizedWins: 0,
    realizedLosses: 0,
    realizedBreakEven: 0,
    realizedPnlKrw: 0,
    attemptedOrders: 0,
    successfulOrders: 0,
    failedWindowCount: 0,
    retryableFailureWindowCount: 0,
  };

  let windowFromMs = null;
  let windowToMs = null;
  for (const sample of samples) {
    if (!sample || typeof sample !== "object") {
      continue;
    }
    const sampleAtMs = Number(sample.sampledAtMs);
    if (Number.isFinite(sampleAtMs)) {
      windowFromMs = windowFromMs === null ? sampleAtMs : Math.min(windowFromMs, sampleAtMs);
      windowToMs = windowToMs === null ? sampleAtMs : Math.max(windowToMs, sampleAtMs);
    }
    totals.sampleCount += 1;
    totals.fillCount += Number(sample.fills?.count || 0);
    totals.buyFillCount += Number(sample.fills?.buyCount || 0);
    totals.sellFillCount += Number(sample.fills?.sellCount || 0);
    totals.totalAmountKrw += Number(sample.fills?.totalAmountKrw || 0);
    totals.totalFeeKrw += Number(sample.fills?.totalFeeKrw || 0);
    totals.totalSignedSlippageBps += Number(sample.fills?.totalSignedSlippageBps || 0);
    totals.totalAbsSlippageBps += Number(sample.fills?.totalAbsSlippageBps || 0);
    totals.slippageSampleCount += Number(sample.fills?.slippageSampleCount || 0);
    totals.realizedTradeCount += Number(sample.realized?.tradeCount || 0);
    totals.realizedWins += Number(sample.realized?.wins || 0);
    totals.realizedLosses += Number(sample.realized?.losses || 0);
    totals.realizedBreakEven += Number(sample.realized?.breakEven || 0);
    totals.realizedPnlKrw += Number(sample.realized?.realizedPnlKrw || 0);
    totals.attemptedOrders += Number(sample.orders?.attemptedOrders || 0);
    totals.successfulOrders += Number(sample.orders?.successfulOrders || 0);
    totals.failedWindowCount += sample.failures?.count ? 1 : 0;
    totals.retryableFailureWindowCount += sample.failures?.allRetryable ? 1 : 0;
  }

  const tradeCount = totals.realizedTradeCount;
  const slippageSamples = totals.slippageSampleCount;
  const windowSeconds = windowFromMs !== null && windowToMs !== null ? (windowToMs - windowFromMs) / 1000 : 0;
  return {
    windowFromMs,
    windowToMs,
    windowFrom: Number.isFinite(windowFromMs) ? new Date(windowFromMs).toISOString() : null,
    windowTo: Number.isFinite(windowToMs) ? new Date(windowToMs).toISOString() : null,
    sampleCount: totals.sampleCount,
    fills: {
      fillCount: totals.fillCount,
      buyFillCount: totals.buyFillCount,
      sellFillCount: totals.sellFillCount,
      totalAmountKrw: roundNum(totals.totalAmountKrw, 2),
      totalFeeKrw: roundNum(totals.totalFeeKrw, 2),
      feeRatePct: totals.totalAmountKrw > 0
        ? roundNum(totals.totalFeeKrw / totals.totalAmountKrw * 100, 4)
        : 0,
      avgSignedSlippageBps: slippageSamples > 0 ? roundNum(totals.totalSignedSlippageBps / slippageSamples, 4) : 0,
      avgAbsSlippageBps: slippageSamples > 0 ? roundNum(totals.totalAbsSlippageBps / slippageSamples, 4) : 0,
      tradeFrequencyPerHour: windowSeconds > 0 ? roundNum((totals.realizedTradeCount / windowSeconds) * 3600, 4) : 0,
    },
    realized: {
      tradeCount: tradeCount,
      wins: totals.realizedWins,
      losses: totals.realizedLosses,
      breakEven: totals.realizedBreakEven,
      winRatePct: tradeCount > 0 ? roundNum(totals.realizedWins / tradeCount * 100, 4) : 0,
      expectancyKrw: tradeCount > 0 ? roundNum(totals.realizedPnlKrw / tradeCount, 2) : 0,
      realizedPnlKrw: roundNum(totals.realizedPnlKrw, 2),
    },
    orders: {
      attempted: totals.attemptedOrders,
      successful: totals.successfulOrders,
      failedWindowCount: totals.failedWindowCount,
      retryableFailureWindowCount: totals.retryableFailureWindowCount,
    },
  };
}

function evaluateExecutionKpiMonitor(summary = {}, thresholds = {}) {
  const realized = summary?.realized || {};
  const fills = summary?.fills || {};
  const minTradeSamples = asPositiveInt(thresholds?.minTradeSamples, 0);
  const alertWinRatePct = asNumber(thresholds?.alertWinRatePct, null);
  const alertExpectancyKrw = asNumber(thresholds?.alertExpectancyKrw, null);
  const alertAbsSlippageBps = asNumber(thresholds?.alertAbsSlippageBps, null);

  const tradeCount = Number(realized.tradeCount || 0);
  const metrics = {
    tradeCount,
    winRatePct: asNumber(realized.winRatePct, 0),
    expectancyKrw: asNumber(realized.expectancyKrw, 0),
    avgAbsSlippageBps: asNumber(fills.avgAbsSlippageBps, 0),
  };
  if (Number.isFinite(minTradeSamples) && tradeCount < minTradeSamples) {
    return {
      enabled: true,
      triggered: false,
      reasons: [`insufficient_trades_for_monitor:${tradeCount} < ${minTradeSamples}`],
      metrics,
      thresholds,
    };
  }

  const reasons = [];
  if (Number.isFinite(alertWinRatePct) && metrics.winRatePct < alertWinRatePct) {
    reasons.push(`low_win_rate:${metrics.winRatePct.toFixed(4)} < ${alertWinRatePct}`);
  }
  if (Number.isFinite(alertExpectancyKrw) && metrics.expectancyKrw < alertExpectancyKrw) {
    reasons.push(`low_expectancy:${metrics.expectancyKrw.toFixed(2)} < ${alertExpectancyKrw}`);
  }
  if (Number.isFinite(alertAbsSlippageBps) && metrics.avgAbsSlippageBps > alertAbsSlippageBps) {
    reasons.push(`high_slippage:${metrics.avgAbsSlippageBps.toFixed(4)} > ${alertAbsSlippageBps}`);
  }

  return {
    enabled: reasons.length > 0 || Number.isFinite(alertWinRatePct)
      || Number.isFinite(alertExpectancyKrw)
      || Number.isFinite(alertAbsSlippageBps),
    triggered: reasons.length > 0,
    reasons,
    metrics,
    thresholds,
  };
}

async function writeJsonl(filePath, payload, maxLines = 0) {
  if (!filePath) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(payload);

  if (!Number.isFinite(maxLines) || maxLines <= 0) {
    await fs.appendFile(filePath, `${line}\n`, "utf8");
    return;
  }

  const maxAllowed = Math.max(1, Math.floor(maxLines));
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  const lines = existing
    ? existing.split("\n").filter((row) => row !== "")
    : [];
  lines.push(line);
  if (lines.length > maxAllowed) {
    lines.splice(0, lines.length - maxAllowed);
  }
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeJson(filePath, payload) {
  if (!filePath) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function safeWrite(filePath, writer, payload, context = {}) {
  try {
    await writer(filePath, payload);
  } catch (error) {
    logger.warn("execution kpi persistence failed", {
      file: filePath,
      ...context,
      error: error.message,
    });
  }
}

async function safeWriteJsonl(filePath, payload, maxLines, context = {}) {
  try {
    await writeJsonl(filePath, payload, maxLines);
  } catch (error) {
    logger.warn("execution kpi persistence failed", {
      file: filePath,
      ...context,
      error: error.message,
    });
  }
}

function ensureLiveCredentials(config) {
  if (!config.exchange.accessKey || !config.exchange.secretKey) {
    throw new Error("Live mode requires BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY");
  }
}

async function ensureLiveAccountPreflight(trader) {
  const accounts = await trader.accountList();
  if (!accounts.ok) {
    throw new Error(`Live preflight failed: ${accounts.error?.message || "account_list failed"}`);
  }

    logger.info("live preflight passed", {
      accountCount: accounts.data.count,
      cashKrw: Math.round(accounts.data.metrics.cashAvailableKrw || accounts.data.metrics.cashKrw || 0),
      exposureKrw: Math.round(accounts.data.metrics.exposureKrw || 0),
    });
  }

export async function runExecutionService({
  system = null,
  config = null,
  stopAfterWindows = 0,
  marketUniverseService = null,
} = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  const aiRefreshRange = normalizeAiRefreshRange(runtimeConfig.ai);
  const logOnlyOnActivity = runtimeConfig.execution?.logOnlyOnActivity !== false;
  const executionDryRun = Boolean(runtimeConfig.execution?.dryRun === true);
  const heartbeatWindowsRaw = Number(runtimeConfig.execution?.heartbeatWindows);
  const heartbeatWindows = Number.isFinite(heartbeatWindowsRaw) && heartbeatWindowsRaw > 0
    ? Math.floor(heartbeatWindowsRaw)
    : 12;
  const kpiMonitorWindowSec = asPositiveInt(runtimeConfig.execution?.kpiMonitorWindowSec, 3600);
  const kpiMonitorWindowMs = kpiMonitorWindowSec * 1_000;
  const kpiMonitorMinTradeSamples = asPositiveInt(runtimeConfig.execution?.kpiMonitorMinTradeSamples, 3);
  const kpiMonitorReportEveryWindows = asPositiveInt(
    runtimeConfig.execution?.kpiMonitorReportEveryWindows,
    1,
  );
  const kpiMonitorSummaryMaxEntries = asPositiveInt(runtimeConfig.execution?.kpiMonitorSummaryMaxEntries, 720);
  const kpiMonitorConfig = {
    alertWinRatePct: asNumber(runtimeConfig.execution?.kpiMonitorAlertWinRatePct, null),
    alertExpectancyKrw: asNumber(runtimeConfig.execution?.kpiMonitorAlertExpectancyKrw, null),
    alertAbsSlippageBps: asNumber(runtimeConfig.execution?.kpiMonitorAlertMaxAbsSlippageBps, null),
    minTradeSamples: kpiMonitorMinTradeSamples,
  };
  const kpiMonitorHistory = [];
  const kpiReportFile = runtimeConfig.execution?.kpiReportFile;
  const kpiReportSummaryFile = runtimeConfig.execution?.kpiReportSummaryFile;
  const auditLog = system
    ? null
    : new HttpAuditLog(runtimeConfig.runtime.httpAuditFile, logger, {
        enabled: runtimeConfig.runtime.httpAuditEnabled,
        maxBytes: runtimeConfig.runtime.httpAuditMaxBytes,
        pruneRatio: runtimeConfig.runtime.httpAuditPruneRatio,
        checkEvery: runtimeConfig.runtime.httpAuditCheckEvery,
      });

  if (auditLog) {
    await auditLog.init();
  }

  const trader = system || new TradingSystem(runtimeConfig, {
    logger,
    exchangeClient: new BithumbClient(runtimeConfig, logger, {
      onRequestEvent: auditLog ? (event) => auditLog.write(event) : null,
    }),
  });
  const aiSettings = new AiSettingsSource(runtimeConfig, logger);
  const marketUniverse = marketUniverseService || new CuratedMarketUniverse(runtimeConfig, logger, trader.marketData);

  try {
    await trader.init();
    await aiSettings.init();
    await marketUniverse.init();
    if (!system && !executionDryRun) {
      ensureLiveCredentials(runtimeConfig);
      await ensureLiveAccountPreflight(trader);
    }

    if (!runtimeConfig.execution.enabled) {
      logger.info("execution service is disabled by config", {
        executionEnabled: false,
      });
      return {
        ok: true,
        windows: 0,
        stoppedBy: "disabled",
      };
    }

    let stopRequested = false;
    let stoppedBy = null;
    const onSignal = (signal) => {
      if (stopRequested) {
        return;
      }
      stopRequested = true;
      stoppedBy = signal;
      logger.warn("execution stop requested", { signal });
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    logger.info("execution service started", {
      mode: executionDryRun ? "dry_run" : "live",
      symbol: runtimeConfig.execution.symbol,
      symbols: normalizeSymbolList(runtimeConfig.execution.symbols, runtimeConfig.execution.symbol),
      amountKrw: runtimeConfig.execution.orderAmountKrw,
      windowSec: runtimeConfig.execution.windowSec,
      cooldownSec: runtimeConfig.execution.cooldownSec,
      maxSymbolsPerWindow: runtimeConfig.execution.maxSymbolsPerWindow,
      maxOrderAttemptsPerWindow: runtimeConfig.execution.maxOrderAttemptsPerWindow,
      aiSettingsEnabled: aiSettings.enabled,
      aiSettingsFile: aiSettings.settingsFile,
      aiSettingsRefreshMinSec: aiRefreshRange.minSec,
      aiSettingsRefreshMaxSec: aiRefreshRange.maxSec,
      marketUniverseEnabled: marketUniverse.enabled,
      marketUniverseQuote: runtimeConfig.marketUniverse?.quote || null,
      marketUniverseFile: runtimeConfig.marketUniverse?.snapshotFile || null,
      httpAuditEnabled: runtimeConfig.runtime.httpAuditEnabled,
      httpAuditFile: runtimeConfig.runtime.httpAuditFile,
      logOnlyOnActivity,
      heartbeatWindows,
      kpiMonitorWindowSec,
      kpiReportFile,
      kpiReportSummaryFile,
      kpiMonitorWindowMs,
    });

    let windows = 0;
    let aiRuntime = await aiSettings.read();
    const requireOptimizerApproval = Boolean(runtimeConfig.ai?.applyOnlyAfterOptimize);
    const startupApproval = getRuntimeApprovalState(aiRuntime, requireOptimizerApproval);
    if (!startupApproval.approved) {
      logger.warn("execution startup uses pending ai snapshot because optimizer approval is required", {
        source: aiRuntime.source,
        meta: aiRuntime.meta || null,
      });
    }
    let aiRuntimeForExecution = startupApproval.approved
      ? aiRuntime
      : aiSettings.defaultSnapshot("runtime_pending_skipped");
    let aiRefresh = nextAiRefreshDelay(aiRefreshRange);
    let nextAiRefreshAt = Date.now() + aiRefresh.ms;
    let streamFailureStreak = 0;
    let lastRuntimeKillSwitch = null;
    let kpiSinceMs = Date.now();
    const aiApplyCooldownMs = Math.max(
      0,
      Math.floor(asPositiveInt(runtimeConfig.ai?.applyCooldownSec, 0) * 1_000),
    );
    const kpiGuardMaxConsecutiveViolations = asNonNegativeInt(
      runtimeConfig.execution?.kpiGuardMaxConsecutiveViolations,
      0,
    );
    let kpiGuardViolationStreak = 0;
    let lastAiExecutionApplyAt = 0;

    if (aiSettings.enabled) {
      logger.info("ai settings snapshot loaded", {
        source: aiRuntimeForExecution.source,
        nextRefreshSec: aiRefresh.sec,
        applyCooldownMs: aiApplyCooldownMs,
        requireOptimizerApproval: startupApproval.require,
        kpiGuardMaxConsecutiveViolations,
      });
    }

    const universeStartup = await marketUniverse.maybeRefresh({ force: true, reason: "startup" });
    if (universeStartup.ok && universeStartup.data) {
      logger.info("market universe refreshed", {
        reason: "startup",
        selectedSymbols: universeStartup.data.symbols.length,
        minAccTradeValue24hKrw: universeStartup.data.criteria?.minAccTradeValue24hKrw ?? null,
        nextRefreshSec: universeStartup.data.nextRefreshSec ?? null,
      });
    } else if (!universeStartup.ok) {
      logger.warn("failed to refresh market universe", {
        reason: "startup",
        error: universeStartup.error?.message || "unknown",
      });
    }

    let lastOverlayHash = null;
    let lastKillSwitch = null;
    let lastStrategyHash = null;
    let lastDecisionHash = null;
    let lastFilteredSymbolsHash = null;
    let lastSkippedAiApprovalHash = null;
    while (!stopRequested) {
      windows += 1;
      const nowMs = Date.now();

      if (aiSettings.enabled && Date.now() >= nextAiRefreshAt) {
        const nextAiRuntime = await aiSettings.read();
        aiRefresh = nextAiRefreshDelay(aiRefreshRange);
        nextAiRefreshAt = Date.now() + aiRefresh.ms;
        if (nextAiRuntime.source === "read_error_fallback") {
          logger.warn("ai settings snapshot refresh skipped: using previous valid runtime", {
            previousSource: aiRuntime.source,
            nextSource: nextAiRuntime.source,
          });
        } else {
          aiRuntime = nextAiRuntime;
          const approval = getRuntimeApprovalState(nextAiRuntime, requireOptimizerApproval);
          const canApplyAiExecution = aiApplyCooldownMs <= 0
            || lastAiExecutionApplyAt === 0
            || nowMs - lastAiExecutionApplyAt >= aiApplyCooldownMs;
          const isApprovedRuntime = approval.approved;
          const skipHash = JSON.stringify({
            approved: isApprovedRuntime,
            source: nextAiRuntime?.source || null,
            meta: nextAiRuntime?.meta || null,
          });

          if (!isApprovedRuntime) {
            if (lastSkippedAiApprovalHash !== skipHash) {
              logger.warn("ai settings snapshot ignored: waiting for optimizer-approved file", {
                source: nextAiRuntime.source,
                meta: nextAiRuntime.meta || null,
              });
              lastSkippedAiApprovalHash = skipHash;
            }
          }

          if (!canApplyAiExecution) {
            logger.warn("ai execution settings update deferred by cooldown", {
              source: aiRuntimeForExecution.source,
              applyCooldownMs: aiApplyCooldownMs,
              waitMs: Math.max(0, aiApplyCooldownMs - (nowMs - lastAiExecutionApplyAt)),
            });
          } else if (!isApprovedRuntime) {
            logger.warn("ai settings snapshot not optimized yet; skipping apply", {
              source: nextAiRuntime.source,
              meta: nextAiRuntime.meta || null,
            });
          } else if (
            JSON.stringify(aiRuntimeForExecution.execution) !== JSON.stringify(nextAiRuntime.execution)
            || JSON.stringify(aiRuntimeForExecution.strategy) !== JSON.stringify(nextAiRuntime.strategy)
            || JSON.stringify(aiRuntimeForExecution.overlay) !== JSON.stringify(nextAiRuntime.overlay)
            || JSON.stringify(aiRuntimeForExecution.decision) !== JSON.stringify(nextAiRuntime.decision)
            || JSON.stringify(aiRuntimeForExecution.controls) !== JSON.stringify(nextAiRuntime.controls)
          ) {
            aiRuntimeForExecution = nextAiRuntime;
            lastAiExecutionApplyAt = nowMs;
          }
          if (isApprovedRuntime) {
            lastSkippedAiApprovalHash = null;
          }

          logger.info("ai settings snapshot refreshed", {
            source: aiRuntimeForExecution.source,
            approved: approval.approved,
            nextRefreshSec: aiRefresh.sec,
          });
        }
      }

      const universeUpdate = await marketUniverse.maybeRefresh({ reason: "periodic" });
      if (universeUpdate.ok && universeUpdate.data && universeUpdate.skipped !== "not_due") {
        logger.info("market universe refreshed", {
          reason: "periodic",
          selectedSymbols: universeUpdate.data.symbols.length,
          minAccTradeValue24hKrw: universeUpdate.data.criteria?.minAccTradeValue24hKrw ?? null,
          nextRefreshSec: universeUpdate.data.nextRefreshSec ?? null,
        });
      } else if (!universeUpdate.ok) {
        logger.warn("failed to refresh market universe", {
          reason: "periodic",
          error: universeUpdate.error?.message || "unknown",
        });
      }

      const effective = aiRuntimeForExecution.execution;

      if (aiSettings.enabled && aiRuntimeForExecution.strategy) {
        const strategyHash = JSON.stringify(aiRuntimeForExecution.strategy);
        if (strategyHash !== lastStrategyHash && typeof trader.applyStrategySettings === "function") {
          const strategyResult = await trader.applyStrategySettings(
            aiRuntimeForExecution.strategy,
            aiRuntimeForExecution.source,
          );
          if (strategyResult.ok) {
            logger.info("strategy updated from ai settings", {
              source: aiRuntimeForExecution.source,
              strategy: strategyResult.data.name,
              symbol: strategyResult.data.defaultSymbol,
            });
            lastStrategyHash = strategyHash;
          } else {
            logger.warn("failed to apply strategy from ai settings", {
              source: aiRuntimeForExecution.source,
              code: strategyResult.code,
              error: strategyResult.error?.message,
            });
          }
        }
      }

      if (aiRuntimeForExecution.overlay) {
        const hash = JSON.stringify(aiRuntimeForExecution.overlay);
        if (hash !== lastOverlayHash) {
          const overlayResult = await trader.overlaySet(aiRuntimeForExecution.overlay);
          if (!overlayResult.ok) {
            logger.warn("failed to apply overlay from ai settings", {
              code: overlayResult.code,
              error: overlayResult.error?.message,
            });
          } else {
            logger.info("overlay updated from ai settings", {
              source: aiRuntimeForExecution.source,
              multiplier: overlayResult.data.multiplier,
              regime: overlayResult.data.regime,
            });
            lastOverlayHash = hash;
          }
        }
      }

      if (aiSettings.enabled && aiRuntimeForExecution.decision) {
        const decisionHash = JSON.stringify(aiRuntimeForExecution.decision);
        if (decisionHash !== lastDecisionHash) {
          logger.info("decision policy updated from ai settings", {
            source: aiRuntimeForExecution.source,
            mode: aiRuntimeForExecution.decision.mode,
            allowBuy: aiRuntimeForExecution.decision.allowBuy,
            allowSell: aiRuntimeForExecution.decision.allowSell,
            forceAction: aiRuntimeForExecution.decision.forceAction,
            symbolOverrides: Object.keys(aiRuntimeForExecution.decision.symbols || {}).length,
          });
          lastDecisionHash = decisionHash;
        }
      }

      if (typeof aiRuntimeForExecution.controls.killSwitch === "boolean"
        && aiRuntimeForExecution.controls.killSwitch !== lastKillSwitch) {
        const killSwitchResult = await trader.setKillSwitch(
          aiRuntimeForExecution.controls.killSwitch,
          "ai_settings_control",
        );
        if (killSwitchResult.ok) {
          lastKillSwitch = aiRuntimeForExecution.controls.killSwitch;
          logger.warn("kill switch updated from ai settings", {
            enabled: aiRuntimeForExecution.controls.killSwitch,
          });
        }
      }

      if (!effective.enabled) {
        logger.warn("execution window skipped by ai settings", {
          window: windows,
          source: aiRuntimeForExecution.source,
        });
        kpiSinceMs = Math.max(kpiSinceMs, Date.now());
        const windowDelayMs = calculateWindowDelayMs(runtimeConfig.execution, streamFailureStreak);

        if (!stopRequested) {
          await sleep(windowDelayMs);
        }

        if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
          stoppedBy = "window_limit";
          break;
        }
        continue;
      }

      const requestedSymbols = normalizeSymbolList(effective.symbols, effective.symbol);
      const filteredSymbols = marketUniverse.filterSymbols(requestedSymbols);
      const targetSymbols = filteredSymbols.symbols;

      if (filteredSymbols.filteredOut.length > 0) {
        const filteredHash = JSON.stringify({
          requestedSymbols,
          rejectedSymbols: filteredSymbols.filteredOut,
          allowedCount: filteredSymbols.allowedCount,
        });
        if (filteredHash !== lastFilteredSymbolsHash) {
          logger.warn("execution symbols filtered by market universe", {
            window: windows,
            source: aiRuntimeForExecution.source,
            requestedSymbols,
            acceptedSymbols: targetSymbols,
            rejectedSymbols: filteredSymbols.filteredOut,
            allowedCount: filteredSymbols.allowedCount,
          });
          lastFilteredSymbolsHash = filteredHash;
        }
      } else {
        lastFilteredSymbolsHash = null;
      }

      const executionStatus = typeof trader.status === "function"
        ? await trader.status()
        : { data: { killSwitch: false, killSwitchReason: null } };
      const runtimeKillSwitch = Boolean(executionStatus?.data?.killSwitch);
      if (lastRuntimeKillSwitch !== runtimeKillSwitch) {
        if (runtimeKillSwitch) {
          logger.warn("execution window skipped: kill switch active", {
            window: windows,
            source: aiRuntimeForExecution.source,
            reason: executionStatus?.data?.killSwitchReason || "runtime_risk_control",
          });
        }
        lastRuntimeKillSwitch = runtimeKillSwitch;
      }
      if (runtimeKillSwitch) {
        const windowDelayMs = calculateWindowDelayMs(runtimeConfig.execution, streamFailureStreak);
        kpiSinceMs = Math.max(kpiSinceMs, Date.now());

        if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
          stoppedBy = "window_limit";
          break;
        }
        if (!stopRequested) {
          await sleep(windowDelayMs);
        }
        continue;
      }

      try {
        if (typeof trader.reconcileOpenOrders === "function") {
          const reconcileResult = await trader.reconcileOpenOrders({ maxCandidates: 8 });
          if (reconcileResult.failed > 0 && runtimeConfig.execution?.logOnlyOnActivity) {
            logger.warn("open order reconciliation had failures", {
              window: windows,
              openCount: reconcileResult.openCount,
              candidates: reconcileResult.candidates,
              reconciled: reconcileResult.reconciled,
              failed: reconcileResult.failed,
            });
          }
        }
      } catch (error) {
        logger.warn("open order reconciliation failed", {
          window: windows,
          reason: error.message,
        });
      }

      if (targetSymbols.length === 0) {
        logger.warn("execution window skipped: no symbols passed market universe filter", {
          window: windows,
          source: aiRuntimeForExecution.source,
          requestedSymbols,
          allowedCount: filteredSymbols.allowedCount,
        });
        const windowDelayMs = calculateWindowDelayMs(runtimeConfig.execution, streamFailureStreak);
        kpiSinceMs = Math.max(kpiSinceMs, Date.now());

        if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
          stoppedBy = "window_limit";
          break;
        }
        if (!stopRequested) {
          await sleep(windowDelayMs);
        }
          continue;
      }

      const configuredMaxSymbolsPerWindow = asPositiveInt(
        effective.maxSymbolsPerWindow,
        runtimeConfig.execution.maxSymbolsPerWindow,
      );
      const symbolsToRun = configuredMaxSymbolsPerWindow > 0
        ? targetSymbols.slice(0, configuredMaxSymbolsPerWindow)
        : targetSymbols;
      if (symbolsToRun.length !== targetSymbols.length) {
        logger.warn("execution symbol count capped per window", {
          window: windows,
          source: aiRuntimeForExecution.source,
          requestedCount: targetSymbols.length,
          cappedCount: symbolsToRun.length,
          maxSymbolsPerWindow: configuredMaxSymbolsPerWindow,
        });
      }
      const configuredMaxOrderAttemptsPerWindow = asPositiveInt(
        effective.maxOrderAttemptsPerWindow,
        runtimeConfig.execution.maxOrderAttemptsPerWindow,
      );

      const perSymbolResults = await Promise.all(
        symbolsToRun.map(async (targetSymbol) => {
          const executionPolicy = resolveDecisionForSymbol(aiRuntimeForExecution.decision, targetSymbol);
          const result = await trader.runStrategyRealtime({
            symbol: targetSymbol,
            amount: effective.orderAmountKrw,
            durationSec: effective.windowSec,
            cooldownSec: effective.cooldownSec,
            dryRun: executionDryRun,
            executionPolicy,
            maxOrderAttemptsPerWindow: configuredMaxOrderAttemptsPerWindow,
          });
          return {
            symbol: targetSymbol,
            result,
          };
        }),
      );

      const aggregated = aggregateWindowResults(perSymbolResults);
      const kpiUntilMs = Date.now();
      const executionKpi = typeof trader.computeExecutionKpi === "function"
        ? trader.computeExecutionKpi({
          sinceMs: kpiSinceMs,
          untilMs: kpiUntilMs,
        })
        : null;
      const safeExecutionKpi = executionKpi && typeof executionKpi === "object"
        ? executionKpi
        : {
          fills: {},
          realized: {},
          positions: {},
        };
      const safeExecutionKpiFills = safeExecutionKpi.fills || {};
      const safeExecutionKpiRealized = safeExecutionKpi.realized || {};
      const safeExecutionKpiPositions = safeExecutionKpi.positions || {};
      kpiSinceMs = kpiUntilMs;
      const kpiGuard = evaluateExecutionKpiGuard(safeExecutionKpi, runtimeConfig.execution, {
        dryRun: executionDryRun,
      });
      if (!executionDryRun) {
        if (!kpiGuard.enabled) {
          kpiGuardViolationStreak = 0;
        } else if (kpiGuard.triggered) {
          kpiGuardViolationStreak += 1;
        } else {
          kpiGuardViolationStreak = 0;
        }
      }

      const allFailedRetryable = aggregated.failed.length > 0 && aggregated.failed.every(isRetryableFailureRow);

      if (kpiGuard.enabled && kpiGuard.triggered && !executionDryRun) {
        logger.warn("execution kpi guard threshold check", {
          window: windows,
          source: aiRuntimeForExecution.source,
          threshold: {
            triggered: kpiGuard.triggered,
            reasons: kpiGuard.reasons,
            violationStreak: kpiGuardViolationStreak,
            maxConsecutiveViolations: kpiGuardMaxConsecutiveViolations,
          },
        });
      }

      const windowSummary = {
        window: windows,
        source: aiRuntimeForExecution.source,
        mode: executionDryRun ? "dry_run" : "live",
        symbols: symbolsToRun,
        symbolCount: symbolsToRun.length,
        maxSymbolsPerWindow: configuredMaxSymbolsPerWindow,
        maxOrderAttemptsPerWindow: configuredMaxOrderAttemptsPerWindow,
        amountKrw: effective.orderAmountKrw,
        tickCount: aggregated.totals.tickCount,
        buySignals: aggregated.totals.buySignals,
        sellSignals: aggregated.totals.sellSignals,
        attemptedOrders: aggregated.totals.attemptedOrders,
        successfulOrders: aggregated.totals.successfulOrders,
        executionKpi: {
          dryRun: executionDryRun,
          fills: {
            count: safeExecutionKpiFills.count || 0,
            buyCount: safeExecutionKpiFills.buyCount || 0,
            sellCount: safeExecutionKpiFills.sellCount || 0,
            totalAmountKrw: roundNum(safeExecutionKpiFills.totalAmountKrw, 2),
            totalFeeKrw: roundNum(safeExecutionKpiFills.totalFeeKrw, 2),
            avgSignedSlippageBps: roundNum(safeExecutionKpiFills.avgSignedSlippageBps, 4),
            avgAbsSlippageBps: roundNum(safeExecutionKpiFills.avgAbsSlippageBps, 4),
          },
          realized: {
            tradeCount: safeExecutionKpiRealized.tradeCount || 0,
            wins: safeExecutionKpiRealized.wins || 0,
            losses: safeExecutionKpiRealized.losses || 0,
            breakEven: safeExecutionKpiRealized.breakEven || 0,
            winRatePct: roundNum(safeExecutionKpiRealized.winRatePct, 4),
            expectancyKrw: roundNum(safeExecutionKpiRealized.expectancyKrw, 2),
            realizedPnlKrw: roundNum(safeExecutionKpiRealized.realizedPnlKrw, 2),
          },
          positionsTracked: Object.keys(safeExecutionKpiPositions || {}).length,
        },
        kpiGuard,
        kpiGuardConsecutiveViolations: kpiGuardViolationStreak,
      };

      const kpiMonitorSample = {
        sampledAtMs: kpiUntilMs,
        window: windows,
        source: aiRuntimeForExecution.source,
        symbolCount: symbolsToRun.length,
        fills: {
            count: safeExecutionKpiFills.count || 0,
            buyCount: safeExecutionKpiFills.buyCount || 0,
            sellCount: safeExecutionKpiFills.sellCount || 0,
            totalAmountKrw: safeExecutionKpiFills.totalAmountKrw || 0,
            totalFeeKrw: safeExecutionKpiFills.totalFeeKrw || 0,
            totalSignedSlippageBps: safeExecutionKpiFills.totalSignedSlippageBps || 0,
            totalAbsSlippageBps: safeExecutionKpiFills.totalAbsSlippageBps || 0,
            slippageSampleCount: safeExecutionKpiFills.slippageSampleCount || 0,
          },
          realized: {
            tradeCount: safeExecutionKpiRealized.tradeCount || 0,
            wins: safeExecutionKpiRealized.wins || 0,
            losses: safeExecutionKpiRealized.losses || 0,
            breakEven: safeExecutionKpiRealized.breakEven || 0,
            realizedPnlKrw: safeExecutionKpiRealized.realizedPnlKrw || 0,
            expectancyKrw: safeExecutionKpiRealized.expectancyKrw || 0,
          },
        orders: {
          attemptedOrders: aggregated.totals.attemptedOrders,
          successfulOrders: aggregated.totals.successfulOrders,
        },
        failures: {
          count: aggregated.failed.length,
          allRetryable: allFailedRetryable,
          codes: Array.from(new Set(
            aggregated.failed.map((row) => row.result?.code).filter((code) => code !== null && code !== undefined),
          )),
        },
      };

      kpiMonitorHistory.push(kpiMonitorSample);
      if (kpiMonitorWindowMs > 0) {
        while (
          kpiMonitorHistory.length > 0
          && kpiMonitorHistory[0].sampledAtMs < kpiUntilMs - kpiMonitorWindowMs
        ) {
          kpiMonitorHistory.shift();
        }
      }
      if (kpiMonitorSummaryMaxEntries > 0 && kpiMonitorHistory.length > kpiMonitorSummaryMaxEntries) {
        kpiMonitorHistory.splice(0, kpiMonitorHistory.length - kpiMonitorSummaryMaxEntries);
      }

      if (kpiMonitorReportEveryWindows > 0 && windows % kpiMonitorReportEveryWindows === 0) {
        const monitorSummary = summarizeExecutionKpiSamples(kpiMonitorHistory);
        const monitorEvaluation = evaluateExecutionKpiMonitor(monitorSummary, kpiMonitorConfig);

        await safeWrite(kpiReportSummaryFile, writeJson, {
          sampledAt: new Date(kpiUntilMs).toISOString(),
          sampledAtMs: kpiUntilMs,
          reportWindow: {
            requestedWindowSec: kpiMonitorWindowSec,
            effectiveWindowMs: kpiMonitorHistory.length > 0
              ? (monitorSummary.windowToMs !== null && monitorSummary.windowFromMs !== null
                ? monitorSummary.windowToMs - monitorSummary.windowFromMs
                : 0)
              : 0,
            sampleCount: kpiMonitorHistory.length,
            summaryMaxEntries: kpiMonitorSummaryMaxEntries,
            reportEveryWindows: kpiMonitorReportEveryWindows,
          },
          thresholds: kpiMonitorConfig,
          summary: monitorSummary,
          evaluation: monitorEvaluation,
          window: windows,
        });
        await safeWriteJsonl(kpiReportFile, {
          sampledAt: new Date(kpiUntilMs).toISOString(),
          sampledAtMs: kpiUntilMs,
          window: windows,
          source: aiRuntimeForExecution.source,
          type: "execution_kpi_monitor",
          summary: monitorSummary,
          evaluation: monitorEvaluation,
        }, kpiMonitorSummaryMaxEntries, {
          type: "kpi_report_jsonl",
          window: windows,
          reportEveryWindows: kpiMonitorReportEveryWindows,
        });

        if (monitorEvaluation.enabled && monitorEvaluation.triggered) {
          logger.warn("execution kpi monitor alert", {
            window: windows,
            source: aiRuntimeForExecution.source,
            reason: monitorEvaluation.reasons,
            thresholds: monitorEvaluation.thresholds,
            metrics: monitorEvaluation.metrics,
          });
        }
      }

      if (
        kpiGuardMaxConsecutiveViolations > 0
        && kpiGuard.enabled
        && kpiGuard.triggered
        && !executionDryRun
        && kpiGuardViolationStreak >= kpiGuardMaxConsecutiveViolations
      ) {
        logger.error("execution kpi guard stop triggered", {
          window: windows,
          source: aiRuntimeForExecution.source,
          symbol: symbolsToRun,
          kpiGuard,
        });
        if (typeof trader.setKillSwitch === "function") {
          await trader.setKillSwitch(true, `kpi_guard: ${kpiGuard.reasons.join(", ") || "unknown"}`);
        }
        stoppedBy = "kpi_guard";
        stopRequested = true;
      }

      if (typeof trader.recordExecutionKpi === "function") {
        await trader.recordExecutionKpi(windowSummary);
      }
      const perSymbolSummary = perSymbolResults.map((row) => ({
        symbol: row.symbol,
        ok: row.result?.ok === true,
        code: row.result?.code ?? null,
        tickCount: row.result?.data?.tickCount ?? 0,
        buySignals: row.result?.data?.buySignals ?? 0,
        sellSignals: row.result?.data?.sellSignals ?? 0,
        attemptedOrders: row.result?.data?.attemptedOrders ?? 0,
        successfulOrders: row.result?.data?.successfulOrders ?? 0,
      }));
      const hasOrderActivity = aggregated.totals.attemptedOrders > 0 || aggregated.totals.successfulOrders > 0;
      if (aggregated.failed.length === 0) {
        streamFailureStreak = 0;
      } else if (allFailedRetryable) {
        streamFailureStreak += 1;
      } else {
        streamFailureStreak = 0;
      }

      const windowDelayMs = calculateWindowDelayMs(runtimeConfig.execution, streamFailureStreak);
      if (windowDelayMs > runtimeConfig.execution.restartDelayMs) {
        logger.warn("execution window delay increased due repeated retryable failures", {
          windows,
          streak: streamFailureStreak,
          delayMs: windowDelayMs,
          restartDelayMs: runtimeConfig.execution.restartDelayMs,
          failedSymbols: aggregated.failed.map((row) => row.symbol),
        });
      }

      if (aggregated.failed.length === 0) {
        if (!logOnlyOnActivity || hasOrderActivity) {
          logger.info("execution window completed", {
            ...windowSummary,
            perSymbol: perSymbolSummary,
          });
        } else if (windows % heartbeatWindows === 0) {
          logger.info("execution window heartbeat", {
            ...windowSummary,
            reason: "no_order_activity",
            heartbeatWindows,
          });
        }
      } else {
        logger.error("execution window failed", {
          ...windowSummary,
          failures: aggregated.failed.map((row) => ({
            symbol: row.symbol,
            code: row.result?.code ?? null,
            codeName: codeName(row.result?.code ?? EXIT_CODES.INTERNAL_ERROR),
            error: row.result?.error || null,
          })),
        });
      }

      if (stopRequested) {
        break;
      }

      if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
        stoppedBy = "window_limit";
        break;
      }

      if (!stopRequested) {
        await sleep(windowDelayMs);
      }
    }

    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    logger.info("execution service stopped", {
      windows,
      stoppedBy: stoppedBy || "requested",
    });

    return {
      ok: true,
      windows,
      stoppedBy: stoppedBy || "requested",
    };
  } finally {
    if (auditLog) {
      await auditLog.flush();
    }
  }
}

async function main() {
  try {
    await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
    await runExecutionService();
  } catch (error) {
    logger.error("execution service fatal error", {
      message: error.message,
    });
    process.exit(EXIT_CODES.INTERNAL_ERROR);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main();
}
