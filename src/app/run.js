#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, normalizeSymbol } from "../config/defaults.js";
import { EXIT_CODES, codeName } from "../config/exit-codes.js";
import { TradingSystem } from "../core/trading-system.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { HttpAuditLog } from "../lib/http-audit-log.js";
import { logger } from "../lib/output.js";
import { AiSettingsSource } from "./ai-settings.js";
import { optimizeAndApplyBest } from "./optimize.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
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
  if (config.runtime.paperMode) {
    return;
  }

  if (!config.exchange.accessKey || !config.exchange.secretKey) {
    throw new Error("Live mode requires BITHUMB_ACCESS_KEY and BITHUMB_SECRET_KEY");
  }
}

async function ensureLiveAccountPreflight(trader, config) {
  if (config.runtime.paperMode) {
    return;
  }

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

export async function runExecutionService({ system = null, config = null } = {}) {
  const runtimeConfig = config || loadConfig(process.env);
  const auditLog = system
    ? null
    : new HttpAuditLog(runtimeConfig.runtime.httpAuditFile, logger, {
        enabled: runtimeConfig.runtime.httpAuditEnabled,
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

  try {
    await trader.init();
    await aiSettings.init();
    if (runtimeConfig.optimizer?.enabled && runtimeConfig.optimizer?.applyOnStart) {
      const optimization = await optimizeAndApplyBest({
        config: runtimeConfig,
        logger: logger,
        apply: runtimeConfig.optimizer.applyToAiSettings !== false,
      });
      if (optimization.ok) {
        logger.info("startup optimizer completed", {
          applied: optimization.data.applied,
          symbol: optimization.data.best?.symbol || null,
          returnPct: optimization.data.best?.metrics?.totalReturnPct ?? null,
          maxDrawdownPct: optimization.data.best?.metrics?.maxDrawdownPct ?? null,
        });
      } else {
        logger.warn("startup optimizer skipped", {
          reason: optimization.error?.message || "unknown",
        });
      }
    }
    ensureLiveCredentials(runtimeConfig);
    await ensureLiveAccountPreflight(trader, runtimeConfig);

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
      mode: runtimeConfig.runtime.paperMode ? "paper" : "live",
      symbol: runtimeConfig.execution.symbol,
      symbols: normalizeSymbolList(runtimeConfig.execution.symbols, runtimeConfig.execution.symbol),
      amountKrw: runtimeConfig.execution.orderAmountKrw,
      windowSec: runtimeConfig.execution.windowSec,
      cooldownSec: runtimeConfig.execution.cooldownSec,
      dryRun: runtimeConfig.execution.dryRun,
      maxWindows: runtimeConfig.execution.maxWindows,
      aiSettingsEnabled: aiSettings.enabled,
      aiSettingsFile: aiSettings.settingsFile,
      httpAuditEnabled: runtimeConfig.runtime.httpAuditEnabled,
      httpAuditFile: runtimeConfig.runtime.httpAuditFile,
      optimizerReoptEnabled: runtimeConfig.optimizer?.enabled && runtimeConfig.optimizer?.reoptEnabled,
      optimizerReoptIntervalSec: runtimeConfig.optimizer?.reoptIntervalSec ?? null,
    });

    const optimizerRuntimeEnabled = runtimeConfig.optimizer?.enabled === true;
    const periodicReoptEnabled = optimizerRuntimeEnabled && runtimeConfig.optimizer?.reoptEnabled === true;
    const reoptIntervalSec = toPositiveInt(runtimeConfig.optimizer?.reoptIntervalSec, 3600);
    const reoptIntervalMs = reoptIntervalSec * 1000;
    let nextReoptAtMs = periodicReoptEnabled ? Date.now() + reoptIntervalMs : null;

    let windows = 0;
    let lastOverlayHash = null;
    let lastKillSwitch = null;
    let lastStrategyHash = null;
    while (!stopRequested) {
      windows += 1;

      if (periodicReoptEnabled && nextReoptAtMs !== null && Date.now() >= nextReoptAtMs) {
        try {
          const optimization = await optimizeAndApplyBest({
            config: runtimeConfig,
            logger: logger,
            apply: runtimeConfig.optimizer.applyToAiSettings !== false,
          });
          if (optimization.ok) {
            logger.info("periodic optimizer completed", {
              window: windows,
              intervalSec: reoptIntervalSec,
              applied: optimization.data.applied,
              symbol: optimization.data.best?.symbol || null,
              returnPct: optimization.data.best?.metrics?.totalReturnPct ?? null,
              maxDrawdownPct: optimization.data.best?.metrics?.maxDrawdownPct ?? null,
            });
          } else {
            logger.warn("periodic optimizer skipped", {
              window: windows,
              intervalSec: reoptIntervalSec,
              reason: optimization.error?.message || "unknown",
            });
          }
        } catch (error) {
          logger.error("periodic optimizer failed", {
            window: windows,
            intervalSec: reoptIntervalSec,
            reason: error.message,
          });
        } finally {
          nextReoptAtMs = Date.now() + reoptIntervalMs;
        }
      }

      const aiRuntime = await aiSettings.read();
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

        if (runtimeConfig.execution.maxWindows > 0 && windows >= runtimeConfig.execution.maxWindows) {
          stoppedBy = "max_windows";
          break;
        }

        if (!stopRequested) {
          await sleep(runtimeConfig.execution.restartDelayMs);
        }
        continue;
      }

      const targetSymbols = normalizeSymbolList(effective.symbols, effective.symbol);
      const perSymbolResults = await Promise.all(
        targetSymbols.map(async (targetSymbol) => {
          const result = await trader.runStrategyRealtime({
            symbol: targetSymbol,
            amount: effective.orderAmountKrw,
            durationSec: effective.windowSec,
            cooldownSec: effective.cooldownSec,
            dryRun: effective.dryRun,
          });
          return {
            symbol: targetSymbol,
            result,
          };
        }),
      );

      const aggregated = aggregateWindowResults(perSymbolResults);
      if (aggregated.failed.length === 0) {
        logger.info("execution window completed", {
          window: windows,
          source: aiRuntime.source,
          symbols: targetSymbols,
          symbolCount: targetSymbols.length,
          amountKrw: effective.orderAmountKrw,
          dryRun: effective.dryRun,
          tickCount: aggregated.totals.tickCount,
          buySignals: aggregated.totals.buySignals,
          sellSignals: aggregated.totals.sellSignals,
          attemptedOrders: aggregated.totals.attemptedOrders,
          successfulOrders: aggregated.totals.successfulOrders,
          perSymbol: perSymbolResults.map((row) => ({
            symbol: row.symbol,
            ok: row.result?.ok === true,
            code: row.result?.code ?? null,
            tickCount: row.result?.data?.tickCount ?? 0,
            buySignals: row.result?.data?.buySignals ?? 0,
            sellSignals: row.result?.data?.sellSignals ?? 0,
            attemptedOrders: row.result?.data?.attemptedOrders ?? 0,
            successfulOrders: row.result?.data?.successfulOrders ?? 0,
          })),
        });
      } else {
        logger.error("execution window failed", {
          window: windows,
          source: aiRuntime.source,
          symbols: targetSymbols,
          symbolCount: targetSymbols.length,
          amountKrw: effective.orderAmountKrw,
          dryRun: effective.dryRun,
          tickCount: aggregated.totals.tickCount,
          buySignals: aggregated.totals.buySignals,
          sellSignals: aggregated.totals.sellSignals,
          attemptedOrders: aggregated.totals.attemptedOrders,
          successfulOrders: aggregated.totals.successfulOrders,
          failures: aggregated.failed.map((row) => ({
            symbol: row.symbol,
            code: row.result?.code ?? null,
            codeName: codeName(row.result?.code ?? EXIT_CODES.INTERNAL_ERROR),
            error: row.result?.error || null,
          })),
        });
      }

      if (runtimeConfig.execution.maxWindows > 0 && windows >= runtimeConfig.execution.maxWindows) {
        stoppedBy = "max_windows";
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
