import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, toBithumbMarket, normalizeSymbol } from "../src/config/defaults.js";

test("defaults include orthodox strategy and overlay settings", () => {
  const config = loadConfig({});
  assert.equal(config.runtime.paperInitialCashKrw, 1000000);
  assert.equal(config.runtime.httpAuditEnabled, true);
  assert.equal(config.runtime.httpAuditFile.endsWith(".trader/http-audit.jsonl"), true);
  assert.equal(config.strategy.name, "risk_managed_momentum");
  assert.equal(config.strategy.candleInterval, "15m");
  assert.equal(config.strategy.momentumLookback, 48);
  assert.equal(config.strategy.volatilityLookback, 96);
  assert.equal(config.strategy.autoSellEnabled, true);
  assert.equal(config.strategy.breakoutLookback, 20);
  assert.equal(config.overlay.timeoutMs, 500);
  assert.equal(config.exchange.publicMaxPerSec, 150);
  assert.equal(config.exchange.privateMaxPerSec, 140);
  assert.equal(config.exchange.wsPublicUrl, "wss://ws-api.bithumb.com/websocket/v1");
  assert.equal(config.exchange.wsPrivateUrl, "wss://ws-api.bithumb.com/websocket/v1/private");
  assert.equal(config.exchange.wsConnectMaxPerSec, 5);
  assert.equal(config.ai.enabled, true);
  assert.equal(config.ai.settingsFile.endsWith(".trader/ai-settings.json"), true);
  assert.equal(config.ai.applyOverlay, true);
  assert.equal(config.ai.applyKillSwitch, true);
  assert.equal(config.execution.enabled, true);
  assert.equal(config.execution.symbol, "BTC_KRW");
  assert.deepEqual(config.execution.symbols, ["BTC_KRW"]);
  assert.equal(config.execution.orderAmountKrw, 5000);
  assert.equal(config.execution.windowSec, 300);
  assert.equal(config.execution.cooldownSec, 30);
  assert.equal(config.execution.dryRun, false);
  assert.equal(config.execution.maxWindows, 0);
  assert.equal(config.optimizer.enabled, true);
  assert.equal(config.optimizer.reoptEnabled, true);
  assert.equal(config.optimizer.reoptIntervalSec, 3600);
});

test("symbol conversion helpers work", () => {
  assert.equal(normalizeSymbol("usdt-krw"), "USDT_KRW");
  assert.equal(toBithumbMarket("USDT_KRW"), "KRW-USDT");
});
