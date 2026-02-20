#!/usr/bin/env node
import { fileURLToPath } from "node:url";
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
    cashKrw: Math.round(accounts.data.metrics.cashKrw || 0),
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
  const heartbeatWindowsRaw = Number(runtimeConfig.execution?.heartbeatWindows);
  const heartbeatWindows = Number.isFinite(heartbeatWindowsRaw) && heartbeatWindowsRaw > 0
    ? Math.floor(heartbeatWindowsRaw)
    : 12;
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
    if (!system) {
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
      mode: "live",
      symbol: runtimeConfig.execution.symbol,
      symbols: normalizeSymbolList(runtimeConfig.execution.symbols, runtimeConfig.execution.symbol),
      amountKrw: runtimeConfig.execution.orderAmountKrw,
      windowSec: runtimeConfig.execution.windowSec,
      cooldownSec: runtimeConfig.execution.cooldownSec,
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
    });

    let windows = 0;
    let aiRuntime = await aiSettings.read();
    let aiRefresh = nextAiRefreshDelay(aiRefreshRange);
    let nextAiRefreshAt = Date.now() + aiRefresh.ms;

    if (aiSettings.enabled) {
      logger.info("ai settings snapshot loaded", {
        source: aiRuntime.source,
        nextRefreshSec: aiRefresh.sec,
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
    while (!stopRequested) {
      windows += 1;

      if (aiSettings.enabled && Date.now() >= nextAiRefreshAt) {
        aiRuntime = await aiSettings.read();
        aiRefresh = nextAiRefreshDelay(aiRefreshRange);
        nextAiRefreshAt = Date.now() + aiRefresh.ms;
        logger.info("ai settings snapshot refreshed", {
          source: aiRuntime.source,
          nextRefreshSec: aiRefresh.sec,
        });
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

      const effective = aiRuntime.execution;

      if (aiSettings.enabled && aiRuntime.strategy) {
        const strategyHash = JSON.stringify(aiRuntime.strategy);
        if (strategyHash !== lastStrategyHash && typeof trader.applyStrategySettings === "function") {
          const strategyResult = await trader.applyStrategySettings(aiRuntime.strategy, aiRuntime.source);
          if (strategyResult.ok) {
            logger.info("strategy updated from ai settings", {
              source: aiRuntime.source,
              strategy: strategyResult.data.name,
              symbol: strategyResult.data.defaultSymbol,
            });
            lastStrategyHash = strategyHash;
          } else {
            logger.warn("failed to apply strategy from ai settings", {
              source: aiRuntime.source,
              code: strategyResult.code,
              error: strategyResult.error?.message,
            });
          }
        }
      }

      if (aiRuntime.overlay) {
        const hash = JSON.stringify(aiRuntime.overlay);
        if (hash !== lastOverlayHash) {
          const overlayResult = await trader.overlaySet(aiRuntime.overlay);
          if (!overlayResult.ok) {
            logger.warn("failed to apply overlay from ai settings", {
              code: overlayResult.code,
              error: overlayResult.error?.message,
            });
          } else {
            logger.info("overlay updated from ai settings", {
              source: aiRuntime.source,
              multiplier: overlayResult.data.multiplier,
              regime: overlayResult.data.regime,
            });
            lastOverlayHash = hash;
          }
        }
      }

      if (aiSettings.enabled && aiRuntime.decision) {
        const decisionHash = JSON.stringify(aiRuntime.decision);
        if (decisionHash !== lastDecisionHash) {
          logger.info("decision policy updated from ai settings", {
            source: aiRuntime.source,
            mode: aiRuntime.decision.mode,
            allowBuy: aiRuntime.decision.allowBuy,
            allowSell: aiRuntime.decision.allowSell,
            forceAction: aiRuntime.decision.forceAction,
            symbolOverrides: Object.keys(aiRuntime.decision.symbols || {}).length,
          });
          lastDecisionHash = decisionHash;
        }
      }

      if (typeof aiRuntime.controls.killSwitch === "boolean" && aiRuntime.controls.killSwitch !== lastKillSwitch) {
        const killSwitchResult = await trader.setKillSwitch(
          aiRuntime.controls.killSwitch,
          "ai_settings_control",
        );
        if (killSwitchResult.ok) {
          lastKillSwitch = aiRuntime.controls.killSwitch;
          logger.warn("kill switch updated from ai settings", {
            enabled: aiRuntime.controls.killSwitch,
          });
        }
      }

      if (!effective.enabled) {
        logger.warn("execution window skipped by ai settings", {
          window: windows,
          source: aiRuntime.source,
        });

        if (!stopRequested) {
          await sleep(runtimeConfig.execution.restartDelayMs);
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
            source: aiRuntime.source,
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

      if (targetSymbols.length === 0) {
        logger.warn("execution window skipped: no symbols passed market universe filter", {
          window: windows,
          source: aiRuntime.source,
          requestedSymbols,
          allowedCount: filteredSymbols.allowedCount,
        });

        if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
          stoppedBy = "window_limit";
          break;
        }
        if (!stopRequested) {
          await sleep(runtimeConfig.execution.restartDelayMs);
        }
        continue;
      }

      const perSymbolResults = await Promise.all(
        targetSymbols.map(async (targetSymbol) => {
          const executionPolicy = resolveDecisionForSymbol(aiRuntime.decision, targetSymbol);
          const result = await trader.runStrategyRealtime({
            symbol: targetSymbol,
            amount: effective.orderAmountKrw,
            durationSec: effective.windowSec,
            cooldownSec: effective.cooldownSec,
            dryRun: false,
            executionPolicy,
          });
          return {
            symbol: targetSymbol,
            result,
          };
        }),
      );

      const aggregated = aggregateWindowResults(perSymbolResults);
      const windowSummary = {
        window: windows,
        source: aiRuntime.source,
        symbols: targetSymbols,
        symbolCount: targetSymbols.length,
        amountKrw: effective.orderAmountKrw,
        tickCount: aggregated.totals.tickCount,
        buySignals: aggregated.totals.buySignals,
        sellSignals: aggregated.totals.sellSignals,
        attemptedOrders: aggregated.totals.attemptedOrders,
        successfulOrders: aggregated.totals.successfulOrders,
      };
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

      if (stopAfterWindows > 0 && windows >= stopAfterWindows) {
        stoppedBy = "window_limit";
        break;
      }

      if (!stopRequested) {
        await sleep(runtimeConfig.execution.restartDelayMs);
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
