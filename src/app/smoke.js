#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig, toBithumbMarket } from "../config/defaults.js";
import { EXIT_CODES } from "../config/exit-codes.js";
import { MarketDataService } from "../core/market-data.js";
import { BithumbClient } from "../exchange/bithumb-client.js";
import { BithumbPublicWsClient } from "../exchange/bithumb-public-ws.js";
import { HttpAuditLog } from "../lib/http-audit-log.js";
import { logger } from "../lib/output.js";
import { nowIso } from "../lib/time.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMinTotal(chancePayload, side = "buy") {
  const sideKey = String(side).toLowerCase() === "sell" ? "ask" : "bid";
  const candidates = [
    chancePayload?.market?.[sideKey]?.min_total,
    chancePayload?.market?.[sideKey]?.minTotal,
  ];
  for (const item of candidates) {
    const parsed = toNumber(item, null);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function rowsFromOrderList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (Array.isArray(payload?.orders)) {
    return payload.orders;
  }
  return [];
}

function resolveOrderId(payload) {
  const candidates = [payload?.uuid, payload?.order_id, payload?.orderId, payload?.id];
  for (const item of candidates) {
    if (item !== undefined && item !== null && String(item).trim() !== "") {
      return String(item).trim();
    }
  }
  return null;
}

function normalizeLimitPrice(symbol, candidatePrice) {
  const quote = String(symbol || "").split("_")[1] || "KRW";
  if (quote.toUpperCase() === "KRW") {
    return Math.max(1, Math.floor(candidatePrice));
  }
  return Number(candidatePrice.toFixed(8));
}

async function check(report, name, fn, { required = true } = {}) {
  try {
    const data = await fn();
    report.checks.push({
      name,
      ok: true,
      required,
      data,
    });
    return { ok: true, data };
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      required,
      error: {
        message: error.message,
        status: error.status ?? null,
      },
    });
    return { ok: false, error };
  }
}

async function checkStream({
  name,
  report,
  open,
  timeoutMs = 5000,
  requireData = true,
  required = true,
}) {
  return check(report, name, async () => {
    let opened = false;
    let row = null;
    let streamError = null;
    let handle = null;

    handle = await open({
      onData: (data) => {
        if (!row) {
          row = data;
        }
        if (requireData && handle) {
          handle.close();
        }
      },
      onStatus: (status) => {
        if (status?.event === "open") {
          opened = true;
        }
      },
      onError: (error) => {
        streamError = error;
        if (handle) {
          handle.close();
        }
      },
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const closeReason = await Promise.race([
      handle.closed.then(() => "closed"),
      timeoutPromise,
    ]);

    if (closeReason === "timeout") {
      handle.close();
      await handle.closed;
    }

    if (streamError) {
      throw streamError;
    }
    if (!opened) {
      throw new Error("stream did not open");
    }
    if (requireData && !row) {
      throw new Error("no stream data within timeout");
    }

    return {
      opened,
      receivedData: Boolean(row),
      sample: row,
    };
  }, { required });
}

async function runSmoke() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  const config = loadConfig(process.env);
  const report = {
    startedAt: nowIso(),
    mode: "live",
    symbol: config.execution.symbol || config.strategy.defaultSymbol,
    market: toBithumbMarket(config.execution.symbol || config.strategy.defaultSymbol),
    checks: [],
    writeSmoke: null,
    audit: {
      enabled: config.runtime.httpAuditEnabled,
      file: config.runtime.httpAuditFile,
    },
  };

  const auditLog = new HttpAuditLog(config.runtime.httpAuditFile, logger, {
    enabled: config.runtime.httpAuditEnabled,
    maxBytes: config.runtime.httpAuditMaxBytes,
    pruneRatio: config.runtime.httpAuditPruneRatio,
    checkEvery: config.runtime.httpAuditCheckEvery,
  });
  await auditLog.init();

  const client = new BithumbClient(config, logger, {
    onRequestEvent: (event) => auditLog.write(event),
  });
  const marketData = new MarketDataService(config, client);
  const wsClient = new BithumbPublicWsClient(config, logger);

  const symbol = report.symbol;
  const hasKeys = Boolean(config.exchange.accessKey && config.exchange.secretKey);

  const accountsCheck = await check(report, "private: GET /v1/accounts", async () => {
    const payload = await client.getAccounts();
    const count = Array.isArray(payload) ? payload.length : Array.isArray(payload?.data) ? payload.data.length : null;
    return { count };
  }, { required: hasKeys });

  const chanceCheck = await check(report, "private: GET /v1/orders/chance", async () => {
    const payload = await client.getOrderChance({ symbol });
    return {
      symbol,
      minBidTotal: parseMinTotal(payload, "buy"),
      minAskTotal: parseMinTotal(payload, "sell"),
    };
  }, { required: hasKeys });

  await check(report, "private: GET /v1/orders", async () => {
    const payload = await client.listOrders({
      symbol,
      states: ["wait", "watch", "done", "cancel"],
      page: 1,
      limit: 20,
    });
    const rows = rowsFromOrderList(payload);
    return { symbol, count: rows.length };
  }, { required: hasKeys });

  await check(report, "public: GET /v1/ticker", async () => {
    const ticker = await marketData.getMarketTicker(symbol);
    const metrics = marketData.extractTickerMetrics(ticker);
    return {
      symbol,
      sourceUrl: ticker.sourceUrl,
      lastPrice: metrics.lastPrice,
    };
  });

  for (const interval of ["1m", "day", "week", "month"]) {
    await check(report, `public: GET candles ${interval}`, async () => {
      const payload = await marketData.getCandles({
        symbol,
        interval,
        count: 1,
      });
      return {
        interval,
        count: payload.candles.length,
        timestamp: payload.candles[0]?.timestamp ?? null,
      };
    });
  }

  await checkStream({
    name: "ws: ticker",
    report,
    timeoutMs: 5000,
    requireData: true,
    open: ({ onData, onStatus, onError }) => wsClient.openTickerStream({
      symbols: [symbol],
      onTicker: onData,
      onStatus,
      onError,
    }),
  });

  await checkStream({
    name: "ws: trade",
    report,
    timeoutMs: 5000,
    requireData: false,
    open: ({ onData, onStatus, onError }) => wsClient.openTradeStream({
      symbols: [symbol],
      onTrade: onData,
      onStatus,
      onError,
    }),
  });

  await checkStream({
    name: "ws: orderbook",
    report,
    timeoutMs: 5000,
    requireData: true,
    open: ({ onData, onStatus, onError }) => wsClient.openOrderbookStream({
      symbols: [symbol],
      onOrderbook: onData,
      onStatus,
      onError,
    }),
  });

  await checkStream({
    name: "ws private: myAsset",
    report,
    timeoutMs: 4000,
    requireData: false,
    required: hasKeys,
    open: ({ onData, onStatus, onError }) => wsClient.openMyAssetStream({
      onMyAsset: onData,
      onStatus,
      onError,
    }),
  });

  await checkStream({
    name: "ws private: myOrder",
    report,
    timeoutMs: 4000,
    requireData: false,
    required: hasKeys,
    open: ({ onData, onStatus, onError }) => wsClient.openMyOrderStream({
      symbols: [symbol],
      onMyOrder: onData,
      onStatus,
      onError,
    }),
  });

  const enableWriteSmoke = toBoolean(process.env.SMOKE_ENABLE_WRITES, false);
  const writeConfirm = String(process.env.SMOKE_WRITE_CONFIRM || "").trim();
  if (enableWriteSmoke) {
    report.writeSmoke = {
      enabled: true,
      confirmed: writeConfirm,
      ok: false,
      steps: [],
    };

    if (!hasKeys) {
      report.writeSmoke.error = "Missing API keys";
    } else if (writeConfirm !== "YES_I_UNDERSTAND") {
      report.writeSmoke.error = "Set SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND to enable write smoke";
    } else if (!accountsCheck.ok || !chanceCheck.ok) {
      report.writeSmoke.error = "Write smoke requires successful account/chance checks";
    } else {
      const chancePayload = await client.getOrderChance({ symbol });
      const minTotal = parseMinTotal(chancePayload, "buy");
      const ticker = await marketData.getMarketTicker(symbol);
      const metrics = marketData.extractTickerMetrics(ticker);
      const lastPrice = toNumber(metrics.lastPrice, null);
      if (lastPrice === null || lastPrice <= 0) {
        report.writeSmoke.error = "Unable to resolve last price";
      } else {
        const amountKrwInput = toNumber(process.env.SMOKE_ORDER_AMOUNT_KRW, null);
        const amountKrw = Math.max(
          minTotal,
          amountKrwInput !== null && amountKrwInput > 0 ? amountKrwInput : minTotal,
        );
        const priceFactor = Math.min(0.95, Math.max(0.01, toNumber(process.env.SMOKE_LIMIT_PRICE_FACTOR, 0.2)));
        const limitPrice = normalizeLimitPrice(symbol, lastPrice * priceFactor);
        const qty = Number((amountKrw / limitPrice).toFixed(8));
        const cancelDelayMs = Math.max(500, Math.floor(toNumber(process.env.SMOKE_CANCEL_DELAY_MS, 1500)));
        const clientOrderKey = `smoke-${Date.now()}`;

        let exchangeOrderId = null;
        try {
          const placed = await client.placeOrder({
            symbol,
            side: "buy",
            type: "limit",
            price: limitPrice,
            qty,
            amountKrw,
            clientOrderKey,
          });
          exchangeOrderId = resolveOrderId(placed);
          report.writeSmoke.steps.push({
            step: "place_limit_buy",
            ok: Boolean(exchangeOrderId),
            data: {
              symbol,
              amountKrw,
              minTotal,
              lastPrice,
              priceFactor,
              limitPrice,
              qty,
              exchangeOrderId,
            },
          });

          if (!exchangeOrderId) {
            throw new Error("placeOrder response has no exchange order id");
          }

          await sleep(cancelDelayMs);
          const canceled = await client.cancelOrder({
            exchangeOrderId,
            symbol,
          });
          report.writeSmoke.steps.push({
            step: "cancel_order",
            ok: true,
            data: {
              exchangeOrderId,
              cancelState: canceled?.state ?? null,
            },
          });

          try {
            const latest = await client.getOrder({
              exchangeOrderId,
              symbol,
            });
            report.writeSmoke.steps.push({
              step: "get_order_after_cancel",
              ok: true,
              data: {
                exchangeOrderId,
                state: latest?.state ?? null,
              },
            });
          } catch (error) {
            report.writeSmoke.steps.push({
              step: "get_order_after_cancel",
              ok: false,
              error: {
                message: error.message,
                status: error.status ?? null,
              },
            });
          }

          report.writeSmoke.ok = true;
        } catch (error) {
          report.writeSmoke.error = error.message;
          report.writeSmoke.ok = false;

          if (exchangeOrderId) {
            try {
              await client.cancelOrder({
                exchangeOrderId,
                symbol,
              });
              report.writeSmoke.steps.push({
                step: "cleanup_cancel",
                ok: true,
                data: { exchangeOrderId },
              });
            } catch (cleanupError) {
              report.writeSmoke.steps.push({
                step: "cleanup_cancel",
                ok: false,
                error: {
                  message: cleanupError.message,
                  status: cleanupError.status ?? null,
                },
              });
            }
          }
        }
      }
    }
  } else {
    report.writeSmoke = {
      enabled: false,
      note: "Set SMOKE_ENABLE_WRITES=true and SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND to run order/cancel smoke",
    };
  }

  await auditLog.flush();

  report.finishedAt = nowIso();
  report.summary = {
    requiredTotal: report.checks.filter((row) => row.required).length,
    requiredPassed: report.checks.filter((row) => row.required && row.ok).length,
    requiredFailed: report.checks.filter((row) => row.required && !row.ok).length,
    optionalFailed: report.checks.filter((row) => !row.required && !row.ok).length,
    writeSmoke: report.writeSmoke?.enabled
      ? Boolean(report.writeSmoke.ok)
      : null,
  };

  return report;
}

async function main() {
  const report = await runSmoke();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const hasRequiredFailure = report.summary.requiredFailed > 0;
  const hasWriteFailure = report.writeSmoke?.enabled === true && report.writeSmoke?.ok !== true;
  if (hasRequiredFailure || hasWriteFailure) {
    process.exit(EXIT_CODES.EXCHANGE_FATAL);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(EXIT_CODES.INTERNAL_ERROR);
  });
}
