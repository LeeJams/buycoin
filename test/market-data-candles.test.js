import test from "node:test";
import assert from "node:assert/strict";
import { MarketDataService } from "../src/core/market-data.js";
import { loadConfig } from "../src/config/defaults.js";
import { CliError } from "../src/lib/errors.js";

class ExchangeMock {
  constructor(response) {
    this.response = response;
    this.calls = [];
  }

  async withRetry(req) {
    this.calls.push(req);
    return this.response;
  }
}

test("market data maps minute candle interval to minutes endpoint", async () => {
  const config = loadConfig({});
  const mock = new ExchangeMock([
    {
      market: "KRW-USDT",
      candle_date_time_utc: "2026-02-13T15:29:00",
      candle_date_time_kst: "2026-02-14T00:29:00",
      opening_price: 1465,
      high_price: 1466,
      low_price: 1465,
      trade_price: 1466,
      candle_acc_trade_volume: 100,
      candle_acc_trade_price: 146600,
      timestamp: 1770996558000,
      unit: 1,
    },
  ]);
  const marketData = new MarketDataService(config, mock);

  const result = await marketData.getCandles({
    symbol: "USDT_KRW",
    interval: "1m",
    count: 10,
  });

  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].path, "/v1/candles/minutes/1");
  assert.equal(mock.calls[0].query.market, "KRW-USDT");
  assert.equal(mock.calls[0].query.count, 10);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].open, 1465);
  assert.equal(result.candles[0].close, 1466);
});

test("market data maps day/week/month candle intervals", async () => {
  const config = loadConfig({});
  const mock = new ExchangeMock([]);
  const marketData = new MarketDataService(config, mock);

  await marketData.getCandles({ symbol: "USDT_KRW", interval: "day", count: 1 });
  await marketData.getCandles({ symbol: "USDT_KRW", interval: "week", count: 1 });
  await marketData.getCandles({ symbol: "USDT_KRW", interval: "month", count: 1 });

  assert.deepEqual(
    mock.calls.map((c) => c.path),
    ["/v1/candles/days", "/v1/candles/weeks", "/v1/candles/months"],
  );
});

test("market data rejects unsupported interval", async () => {
  const config = loadConfig({});
  const marketData = new MarketDataService(config, new ExchangeMock([]));

  await assert.rejects(
    marketData.getCandles({ symbol: "USDT_KRW", interval: "2m", count: 1 }),
    (error) => error instanceof CliError && error.type === "INVALID_ARGUMENT",
  );
});

test("market data rejects too-large candle count", async () => {
  const config = loadConfig({});
  const marketData = new MarketDataService(config, new ExchangeMock([]));

  await assert.rejects(
    marketData.getCandles({ symbol: "USDT_KRW", interval: "1m", count: 201 }),
    (error) => error instanceof CliError && error.type === "INVALID_ARGUMENT",
  );
});
