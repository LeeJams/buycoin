import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { TradingSystem } from "../src/core/trading-system.js";

class ExchangeStub {
  isRetryableError() {
    return false;
  }
}

class MarketDataStub {
  constructor(price) {
    this.price = price;
  }

  async getMarketTicker(symbol) {
    return {
      symbol,
      payload: [
        {
          trade_price: this.price,
        },
      ],
    };
  }

  extractTickerMetrics(payload) {
    return {
      lastPrice: payload?.payload?.[0]?.trade_price ?? this.price,
      changeRate: 0,
      accTradeValue24h: 0,
    };
  }
}

async function createConfig(extra = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-mode-test-"));
  return loadConfig({
    TRADER_STATE_FILE: path.join(baseDir, "state.json"),
    TRADER_OVERLAY_FILE: path.join(baseDir, "overlay.json"),
    TRADER_PAPER_MODE: "true",
    TRADER_PAPER_INITIAL_CASH_KRW: "1000000",
    STRATEGY_NAME: "risk_managed_momentum",
    ...extra,
  });
}

test("paper mode starts with default KRW cash and no holdings", async () => {
  const config = await createConfig();
  const system = new TradingSystem(config, {
    exchangeClient: new ExchangeStub(),
    marketData: new MarketDataStub(1500),
  });
  await system.init();

  const account = await system.accountList();
  assert.equal(account.ok, true);
  assert.equal(account.data.source, "paper_wallet");
  assert.equal(account.data.metrics.cashKrw, 1000000);
  assert.equal(account.data.metrics.exposureKrw, 0);
});

test("paper mode updates wallet after buy and sell", async () => {
  const config = await createConfig();
  const system = new TradingSystem(config, {
    exchangeClient: new ExchangeStub(),
    marketData: new MarketDataStub(1500),
  });
  await system.init();

  const buy = await system.placeOrder({
    symbol: "USDT_KRW",
    side: "buy",
    type: "market",
    amount: 150000,
    dryRun: false,
    reason: "paper_buy",
  });
  assert.equal(buy.ok, true);
  assert.equal(buy.data.paper, true);
  assert.equal(Number.isFinite(buy.data.qty), true);
  assert.equal(buy.data.qty > 0, true);

  const afterBuy = await system.accountList();
  assert.equal(afterBuy.ok, true);
  assert.equal(afterBuy.data.metrics.cashKrw < 1000000, true);
  assert.equal(afterBuy.data.metrics.holdings.USDT > 0, true);

  const sell = await system.placeOrder({
    symbol: "USDT_KRW",
    side: "sell",
    type: "market",
    amount: 75000,
    price: 1500,
    dryRun: false,
    reason: "paper_sell",
  });
  assert.equal(sell.ok, true);
  assert.equal(sell.data.paper, true);

  const afterSell = await system.accountList();
  assert.equal(afterSell.ok, true);
  assert.equal(afterSell.data.metrics.cashKrw > afterBuy.data.metrics.cashKrw, true);
});
