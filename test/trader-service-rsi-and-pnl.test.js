import test from "node:test";
import assert from "node:assert/strict";
import { TraderService } from "../src/core/trader-service.js";
import { EXIT_CODES } from "../src/config/exit-codes.js";
import { createTempStore } from "../test-utils/helpers.js";

class MarketDataRsiMock {
  constructor(closes = []) {
    this.closes = closes;
  }

  async getCandles({ symbol, interval, count, to }) {
    return {
      symbol,
      interval,
      count,
      to,
      sourceUrl: "mock://candles",
      candles: this.closes.map((close, idx) => ({
        symbol,
        interval,
        close,
        timestamp: idx,
      })),
      raw: [],
    };
  }
}

class ExchangePnlMock {
  constructor() {
    this.calls = [];
  }

  isRetryableError() {
    return false;
  }

  async getOrderChance(params) {
    this.calls.push({ fn: "getOrderChance", params });
    return {
      market: {
        bid: { min_total: "5000" },
        ask: { min_total: "5000" },
      },
    };
  }

  async getAccounts() {
    this.calls.push({ fn: "getAccounts" });
    return [
      {
        currency: "KRW",
        balance: "90000",
        locked: "0",
        avg_buy_price: "0",
        unit_currency: "KRW",
      },
    ];
  }
}

class RiskContextCaptureMock {
  constructor() {
    this.contexts = [];
  }

  evaluateOrder(_order, context) {
    this.contexts.push(context);
    return {
      allowed: true,
      reasons: [],
      metrics: {
        appliedMinOrderNotional: 5000,
        dynamicMinOrderNotional: null,
      },
    };
  }

  async recordRejection() {}
}

class OrderManagerPnlMock {
  async placeOrder(order) {
    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: {
        id: "placed-pnl-1",
        exchangeOrderId: "exchange-pnl-1",
        symbol: order.symbol,
        side: order.side,
        type: order.type,
      },
    };
  }
}

test("rsi strategy run returns BUY signal and places paper market buy order", async () => {
  const { config, store } = await createTempStore();
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85];
  const service = new TraderService(config, {
    store,
    marketData: new MarketDataRsiMock(closes),
  });
  await service.init();

  const result = await service.runStrategy({
    name: "rsi",
    symbol: "USDT_KRW",
    dryRun: false,
    budget: 6000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.signal.signal, "BUY");
  assert.equal(result.data.order !== null, true);
  assert.equal(result.data.order.type, "market");

  const savedRun = store.snapshot().strategyRuns.find((item) => item.id === result.data.runId);
  assert.equal(savedRun.status, "COMPLETED");
});

test("rsi strategy run returns HOLD and does not place order when RSI is neutral", async () => {
  const { config, store } = await createTempStore();
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
  const service = new TraderService(config, {
    store,
    marketData: new MarketDataRsiMock(closes),
  });
  await service.init();

  const result = await service.runStrategy({
    name: "rsi",
    symbol: "USDT_KRW",
    dryRun: false,
    budget: 6000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.signal.signal, "HOLD");
  assert.equal(result.data.order, null);
});

test("place order injects daily PnL context using initial capital baseline", async () => {
  const { config, store } = await createTempStore();
  config.trading.initialCapitalKrw = 100000;

  const exchange = new ExchangePnlMock();
  const risk = new RiskContextCaptureMock();
  const orderManager = new OrderManagerPnlMock();
  const service = new TraderService(config, {
    store,
    exchangeClient: exchange,
    riskEngine: risk,
    orderManager,
  });
  await service.init();
  await service.setPaperMode(false, "pnl-context-test");

  const result = await service.placeOrderDirect({
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amount: 6000,
    clientOrderKey: "pnl-context-check-1",
  });

  assert.equal(result.ok, true);
  assert.equal(risk.contexts.length > 0, true);
  assert.equal(risk.contexts[0].dailyRealizedPnlKrw, -10000);
  assert.equal(risk.contexts[0].dailyPnlMeta.baselineEquityKrw, 100000);
  assert.equal(risk.contexts[0].dailyPnlMeta.currentEquityKrw, 90000);

  const baseline = store.snapshot().settings.dailyPnlBaseline;
  assert.equal(baseline.equityKrw, 100000);
  assert.equal(typeof baseline.date, "string");
});
