import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { TradingSystem } from "../src/core/trading-system.js";

class ExchangeMock {
  constructor() {
    this.placeCalls = [];
    this.listCalls = [];
  }

  isRetryableError() {
    return false;
  }

  async getAccounts() {
    return [
      {
        currency: "KRW",
        balance: "120000",
        locked: "0",
        avg_buy_price: "0",
        unit_currency: "KRW",
      },
    ];
  }

  async getOrderChance() {
    return {
      market: {
        bid: { min_total: "5000" },
        ask: { min_total: "5000" },
      },
    };
  }

  async placeOrder(payload) {
    this.placeCalls.push(payload);
    return { uuid: "exchange-1" };
  }

  async listOrders(payload) {
    this.listCalls.push(payload);
    return [];
  }

  async getOrder() {
    return { uuid: "exchange-1" };
  }

  async cancelOrder() {
    return { uuid: "exchange-1", state: "cancel" };
  }
}

class MarketDataMock {
  async getCandles() {
    return {
      symbol: "BTC_KRW",
      interval: "15m",
      candles: [
        { timestamp: 1, high: 100, low: 90, close: 95 },
        { timestamp: 2, high: 101, low: 91, close: 96 },
        { timestamp: 3, high: 102, low: 92, close: 97 },
        { timestamp: 4, high: 103, low: 93, close: 104 },
      ],
      raw: [],
    };
  }
}

class OverlayMock {
  async readCurrent() {
    return {
      multiplier: 1.2,
      source: "overlay_multiplier",
      stale: false,
      updatedAt: new Date().toISOString(),
      score: null,
      regime: "risk_on",
    };
  }
}

class WsClientMock {
  constructor(ticks = []) {
    this.ticks = ticks;
    this.openCalls = [];
  }

  async openTickerStream({ symbols, onTicker, onError }) {
    this.openCalls.push({ symbols });
    let closed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      resolveClosed({ code: 1000, reason: "mock_closed" });
    };

    queueMicrotask(() => {
      try {
        for (const tick of this.ticks) {
          if (closed) {
            break;
          }
          onTicker(tick);
        }
      } catch (error) {
        onError(error);
      } finally {
        close();
      }
    });

    return {
      close,
      closed: closedPromise,
    };
  }
}

async function createConfig(extra = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "system-test-"));
  return loadConfig({
    TRADER_STATE_FILE: path.join(baseDir, "state.json"),
    TRADER_OVERLAY_FILE: path.join(baseDir, "overlay.json"),
    TRADER_PAPER_MODE: "false",
    STRATEGY_NAME: "breakout",
    STRATEGY_BREAKOUT_LOOKBACK: "3",
    STRATEGY_BREAKOUT_BUFFER_BPS: "0",
    STRATEGY_BASE_ORDER_AMOUNT_KRW: "5000",
    ...extra,
  });
}

test("strategy run executes immediate market buy on BUY signal", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW" });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.action, "BUY");
  assert.equal(result.data.amountAdjustedKrw, 6000);
  assert.equal(result.data.order.exchangeOrderId, "exchange-1");
  assert.equal(exchange.placeCalls.length, 1);
});

test("strategy run dry-run does not submit exchange order", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.runStrategyOnce({ symbol: "BTC_KRW", dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.action, "BUY");
  assert.equal(result.data.order.dryRun, true);
  assert.equal(exchange.placeCalls.length, 0);
});

test("stream ticker collects realtime ticks from websocket client", async () => {
  const config = await createConfig();
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 100, streamType: "REALTIME", timestamp: 1 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 101, streamType: "REALTIME", timestamp: 2 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 102, streamType: "REALTIME", timestamp: 3 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: new ExchangeMock(),
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.streamTicker({
    symbol: "BTC_KRW",
    durationSec: 1,
    maxEvents: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.count, 3);
  assert.equal(result.data.ticks[2].tradePrice, 102);
  assert.equal(wsClient.openCalls.length, 1);
});

test("strategy realtime executes buy from websocket ticks", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const wsClient = new WsClientMock([
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 95, streamType: "REALTIME", timestamp: 1 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 96, streamType: "REALTIME", timestamp: 2 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 97, streamType: "REALTIME", timestamp: 3 },
    { symbol: "BTC_KRW", market: "KRW-BTC", tradePrice: 104, streamType: "REALTIME", timestamp: 4 },
  ]);

  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
    wsClient,
  });
  await system.init();

  const result = await system.runStrategyRealtime({
    symbol: "BTC_KRW",
    durationSec: 1,
    cooldownSec: 0,
    dryRun: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.buySignals >= 1, true);
  assert.equal(result.data.successfulOrders >= 1, true);
  assert.equal(exchange.placeCalls.length >= 1, true);
});

test("orderList forwards uuids/states options to exchange listOrders", async () => {
  const config = await createConfig();
  const exchange = new ExchangeMock();
  const system = new TradingSystem(config, {
    exchangeClient: exchange,
    marketData: new MarketDataMock(),
    overlayEngine: new OverlayMock(),
  });
  await system.init();

  const result = await system.orderList({
    symbol: "BTC_KRW",
    uuids: "id-1,id-2",
    states: ["wait", "watch"],
    page: 2,
    limit: 50,
    orderBy: "asc",
  });

  assert.equal(result.ok, true);
  assert.equal(exchange.listCalls.length, 1);
  assert.deepEqual(exchange.listCalls[0], {
    symbol: "BTC_KRW",
    uuids: ["id-1", "id-2"],
    state: null,
    states: ["wait", "watch"],
    page: 2,
    limit: 50,
    orderBy: "asc",
  });
});
