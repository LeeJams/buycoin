import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/defaults.js";
import { SymbolSelector } from "../src/core/symbol-selector.js";

class MarketDataMock {
  constructor(dataset) {
    this.dataset = dataset;
  }

  async getMarketTicker(symbol) {
    const metrics = this.dataset[symbol];
    if (!metrics) {
      throw new Error(`missing market data for ${symbol}`);
    }

    return {
      symbol,
      payload: metrics,
    };
  }

  extractTickerMetrics(tickerResponse) {
    return tickerResponse.payload;
  }
}

test("symbol selector picks highest momentum candidate", async () => {
  const config = loadConfig({
    TRADER_AUTO_SELECT_MODE: "momentum",
    TRADER_AUTO_SELECT_CANDIDATES: "BTC_KRW,ETH_KRW,XRP_KRW",
  });
  const marketData = new MarketDataMock({
    BTC_KRW: { lastPrice: 100, changeRate: 0.01, accTradeValue24h: 100_000_000_000 },
    ETH_KRW: { lastPrice: 200, changeRate: 0.03, accTradeValue24h: 80_000_000_000 },
    XRP_KRW: { lastPrice: 10, changeRate: 0.005, accTradeValue24h: 120_000_000_000 },
  });
  const selector = new SymbolSelector(config, marketData);

  const pick = await selector.select({ side: "buy" });
  assert.equal(pick.symbol, "ETH_KRW");
  assert.equal(pick.mode, "momentum");
});

test("symbol selector supports volume mode", async () => {
  const config = loadConfig({
    TRADER_AUTO_SELECT_MODE: "volume",
    TRADER_AUTO_SELECT_CANDIDATES: "BTC_KRW,ETH_KRW,XRP_KRW",
  });
  const marketData = new MarketDataMock({
    BTC_KRW: { lastPrice: 100, changeRate: 0.05, accTradeValue24h: 30_000_000_000 },
    ETH_KRW: { lastPrice: 200, changeRate: 0.02, accTradeValue24h: 50_000_000_000 },
    XRP_KRW: { lastPrice: 10, changeRate: -0.01, accTradeValue24h: 80_000_000_000 },
  });
  const selector = new SymbolSelector(config, marketData);

  const pick = await selector.select({ side: "buy", mode: "volume" });
  assert.equal(pick.symbol, "XRP_KRW");
  assert.equal(pick.mode, "volume");
});
