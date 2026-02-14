import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/defaults.js";

test("config defaults include bithumb per-second limits", () => {
  const config = loadConfig({});
  assert.equal(config.exchange.publicMaxPerSec, 150);
  assert.equal(config.exchange.privateMaxPerSec, 140);
});

test("invalid per-second limits fall back to safe defaults", () => {
  const config = loadConfig({
    BITHUMB_PUBLIC_MAX_PER_SEC: "bad",
    BITHUMB_PRIVATE_MAX_PER_SEC: "0",
  });

  assert.equal(config.exchange.publicMaxPerSec, 150);
  assert.equal(config.exchange.privateMaxPerSec, 140);
});

test("symbol-specific minimum notional map is parsed from env", () => {
  const config = loadConfig({
    RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL: "usdt-krw:1000,BTC_KRW:7000,INVALID,bad:0",
  });

  assert.deepEqual(config.trading.minOrderNotionalBySymbol, {
    USDT_KRW: 1000,
    BTC_KRW: 7000,
  });
});

test("resilience defaults are configured", () => {
  const config = loadConfig({});
  assert.equal(config.runtime.stateLockStaleMs, 30000);
  assert.equal(config.runtime.startupReconcile, true);
  assert.equal(config.resilience.autoRetryEnabled, true);
  assert.equal(config.resilience.autoRetryAttempts, 2);
  assert.equal(config.resilience.autoKillSwitchEnabled, true);
});

test("ai hard cap defaults are configured", () => {
  const config = loadConfig({});
  assert.equal(config.trading.aiMaxOrderNotionalKrw, 100000);
  assert.equal(config.trading.aiMaxOrdersPerWindow, 3);
  assert.equal(config.trading.aiOrderCountWindowSec, 60);
  assert.equal(config.trading.aiMaxTotalExposureKrw, 500000);
});
