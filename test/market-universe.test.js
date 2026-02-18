import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CuratedMarketUniverse } from "../src/core/market-universe.js";

function createMockMarketData({ markets, tickersByMarket }) {
  return {
    async publicGet(apiPath, query = {}) {
      if (apiPath === "/v1/market/all") {
        return markets;
      }
      if (apiPath === "/v1/ticker") {
        const list = String(query.markets || "")
          .split(",")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean);
        return list
          .map((market) => tickersByMarket[market])
          .filter(Boolean)
          .map((row) => ({ ...row }));
      }
      throw new Error(`unexpected path: ${apiPath}`);
    },
  };
}

test("market universe selects liquid KRW symbols and excludes weird ones", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "market-universe-"));
  const snapshotFile = path.join(dir, "market-universe.json");
  const markets = [
    { market: "KRW-BTC", market_warning: "NONE", korean_name: "비트코인", english_name: "Bitcoin" },
    { market: "KRW-ETH", market_warning: "NONE", korean_name: "이더리움", english_name: "Ethereum" },
    { market: "KRW-USDT", market_warning: "NONE", korean_name: "테더", english_name: "Tether" },
    { market: "KRW-XRP", market_warning: "NONE", korean_name: "리플", english_name: "XRP" },
    { market: "KRW-DOGE", market_warning: "NONE", korean_name: "도지코인", english_name: "Dogecoin" },
    { market: "KRW-A", market_warning: "NONE", korean_name: "볼타", english_name: "Vaulta" },
    { market: "KRW-WARN", market_warning: "CAUTION", korean_name: "주의코인", english_name: "WarningCoin" },
  ];
  const tickersByMarket = {
    "KRW-BTC": { market: "KRW-BTC", trade_price: 100000000, acc_trade_price_24h: 80_000_000_000 },
    "KRW-ETH": { market: "KRW-ETH", trade_price: 3000000, acc_trade_price_24h: 60_000_000_000 },
    "KRW-USDT": { market: "KRW-USDT", trade_price: 1500, acc_trade_price_24h: 90_000_000_000 },
    "KRW-XRP": { market: "KRW-XRP", trade_price: 4000, acc_trade_price_24h: 45_000_000_000 },
    "KRW-DOGE": { market: "KRW-DOGE", trade_price: 500, acc_trade_price_24h: 6_000_000_000 },
    "KRW-A": { market: "KRW-A", trade_price: 300, acc_trade_price_24h: 50_000_000_000 },
    "KRW-WARN": { market: "KRW-WARN", trade_price: 800, acc_trade_price_24h: 40_000_000_000 },
  };

  const config = {
    marketUniverse: {
      enabled: true,
      quote: "KRW",
      minAccTradeValue24hKrw: 10_000_000_000,
      minPriceKrw: 1,
      maxSymbols: 4,
      includeSymbols: ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
      excludeSymbols: [],
      minBaseAssetLength: 2,
      refreshMinSec: 3600,
      refreshMaxSec: 3600,
      tickerChunkSize: 2,
      snapshotFile,
    },
  };

  const universe = new CuratedMarketUniverse(config, null, createMockMarketData({ markets, tickersByMarket }));
  await universe.init();
  const result = await universe.refresh({ reason: "test" });
  assert.equal(result.ok, true);

  const snapshot = result.data;
  assert.deepEqual(snapshot.symbols, ["BTC_KRW", "ETH_KRW", "USDT_KRW", "XRP_KRW"]);
  assert.equal(snapshot.totals.selectedSymbols, 4);
  assert.equal(snapshot.excludedCounts.short_base_symbol, 1);
  assert.equal(snapshot.excludedCounts.market_warning, 1);
  assert.equal(snapshot.excludedCounts.low_24h_value, 1);

  const raw = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  assert.deepEqual(raw.symbols, snapshot.symbols);
});

test("market universe filterSymbols rejects symbols outside current universe", async () => {
  const config = {
    marketUniverse: {
      enabled: true,
      includeSymbols: ["BTC_KRW"],
      excludeSymbols: [],
      quote: "KRW",
      minAccTradeValue24hKrw: 1,
      minPriceKrw: 1,
      maxSymbols: 2,
      minBaseAssetLength: 2,
      refreshMinSec: 3600,
      refreshMaxSec: 3600,
      tickerChunkSize: 40,
      snapshotFile: null,
    },
  };
  const universe = new CuratedMarketUniverse(config, null, createMockMarketData({
    markets: [{ market: "KRW-BTC", market_warning: "NONE" }],
    tickersByMarket: { "KRW-BTC": { market: "KRW-BTC", trade_price: 1, acc_trade_price_24h: 10 } },
  }));
  await universe.maybeRefresh({ force: true, reason: "test" });

  const filtered = universe.filterSymbols(["BTC_KRW", "ETH_KRW", "USDT_KRW"]);
  assert.deepEqual(filtered.symbols, ["BTC_KRW"]);
  assert.deepEqual(filtered.filteredOut, ["ETH_KRW", "USDT_KRW"]);
});
