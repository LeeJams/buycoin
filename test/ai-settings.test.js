import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { AiSettingsSource } from "../src/app/ai-settings.js";

async function makeConfig(extra = {}) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-settings-test-"));
  return loadConfig({
    AI_SETTINGS_FILE: path.join(baseDir, "ai-settings.json"),
    EXECUTION_SYMBOL: "BTC_KRW",
    EXECUTION_ORDER_AMOUNT_KRW: "5000",
    EXECUTION_WINDOW_SEC: "30",
    EXECUTION_COOLDOWN_SEC: "5",
    ...extra,
  });
}

test("ai settings source creates template when file is missing", async () => {
  const config = await makeConfig();
  const source = new AiSettingsSource(config);

  await source.init();
  const raw = await fs.readFile(config.ai.settingsFile, "utf8");
  const parsed = JSON.parse(raw);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.execution.symbol, "BTC_KRW");
  assert.equal(parsed.execution.orderAmountKrw, 5000);
});

test("ai settings source reads execution overrides and overlay", async () => {
  const config = await makeConfig();
  const source = new AiSettingsSource(config);
  await source.init();

  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "usdt-krw",
      orderAmountKrw: 10000,
      windowSec: 120,
      cooldownSec: 15,
      dryRun: false,
    },
    strategy: {
      name: "risk_managed_momentum",
      defaultSymbol: "eth-krw",
      candleInterval: "5m",
      candleCount: 180,
      momentumLookback: 36,
      volatilityLookback: 96,
      momentumEntryBps: 16,
      momentumExitBps: 10,
      targetVolatilityPct: 0.5,
      riskManagedMinMultiplier: 0.5,
      riskManagedMaxMultiplier: 1.7,
      autoSellEnabled: true,
      baseOrderAmountKrw: 7000,
    },
    overlay: {
      multiplier: 0.75,
      score: -0.2,
      regime: "risk_off",
    },
    controls: {
      killSwitch: true,
    },
  };
  await fs.writeFile(config.ai.settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const result = await source.read();

  assert.equal(result.execution.symbol, "USDT_KRW");
  assert.equal(result.execution.orderAmountKrw, 10000);
  assert.equal(result.execution.windowSec, 120);
  assert.equal(result.execution.cooldownSec, 15);
  assert.equal(result.execution.dryRun, false);
  assert.equal(result.strategy.name, "risk_managed_momentum");
  assert.equal(result.strategy.defaultSymbol, "ETH_KRW");
  assert.equal(result.strategy.candleInterval, "5m");
  assert.equal(result.strategy.momentumLookback, 36);
  assert.equal(result.strategy.momentumEntryBps, 16);
  assert.equal(result.overlay.multiplier, 0.75);
  assert.equal(result.controls.killSwitch, true);
});
