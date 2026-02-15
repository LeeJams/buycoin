import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExecutionService } from "../src/app/run.js";

class SystemMock {
  constructor(result = null) {
    this.result = result || {
      ok: true,
      code: 0,
      data: {
        tickCount: 1,
        buySignals: 0,
        attemptedOrders: 0,
        successfulOrders: 0,
      },
    };
    this.calls = {
      init: 0,
      realtime: 0,
      strategyApply: 0,
      args: [],
      strategyArgs: [],
    };
  }

  async init() {
    this.calls.init += 1;
  }

  async runStrategyRealtime(args) {
    this.calls.realtime += 1;
    this.calls.args.push(args);
    return this.result;
  }

  async applyStrategySettings(args) {
    this.calls.strategyApply += 1;
    this.calls.strategyArgs.push(args);
    return {
      ok: true,
      code: 0,
      data: args,
    };
  }
}

function baseConfig() {
  return {
    runtime: {
      paperMode: true,
    },
    exchange: {
      accessKey: "",
      secretKey: "",
    },
    ai: {
      enabled: false,
      settingsFile: null,
      applyOverlay: true,
      applyKillSwitch: true,
    },
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW"],
      orderAmountKrw: 5000,
      windowSec: 1,
      cooldownSec: 1,
      dryRun: true,
      restartDelayMs: 1,
      maxWindows: 2,
    },
  };
}

test("execution service runs realtime windows by maxWindows", async () => {
  const config = baseConfig();
  const system = new SystemMock();

  const result = await runExecutionService({
    system,
    config,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 2);
  assert.equal(result.stoppedBy, "max_windows");
  assert.equal(system.calls.init, 1);
  assert.equal(system.calls.realtime, 2);
  assert.equal(system.calls.args[0].symbol, "BTC_KRW");
});

test("execution service exits immediately when disabled", async () => {
  const config = baseConfig();
  config.execution.enabled = false;
  const system = new SystemMock();

  const result = await runExecutionService({
    system,
    config,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 0);
  assert.equal(result.stoppedBy, "disabled");
  assert.equal(system.calls.init, 1);
  assert.equal(system.calls.realtime, 0);
});

test("execution service applies ai execution settings per window", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-ai-"));
  const settingsFile = path.join(baseDir, "ai-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "USDT_KRW",
      symbols: ["USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 2,
      cooldownSec: 0,
      dryRun: false,
    },
    strategy: {
      name: "risk_managed_momentum",
      defaultSymbol: "USDT_KRW",
      candleInterval: "5m",
      momentumLookback: 36,
      volatilityLookback: 96,
      momentumEntryBps: 16,
      momentumExitBps: 10,
      targetVolatilityPct: 0.35,
      riskManagedMinMultiplier: 0.4,
      riskManagedMaxMultiplier: 1.8,
      autoSellEnabled: true,
      baseOrderAmountKrw: 7000,
      candleCount: 120,
      breakoutLookback: 20,
      breakoutBufferBps: 5,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.ai.enabled = true;
  config.ai.settingsFile = settingsFile;
  config.execution.maxWindows = 1;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.strategyApply, 1);
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 7000);
  assert.equal(system.calls.args[0].durationSec, 2);
  assert.equal(system.calls.args[0].cooldownSec, 0);
  assert.equal(system.calls.args[0].dryRun, false);
});

test("execution service runs multiple symbols in one window when ai settings provide symbols", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-ai-multi-"));
  const settingsFile = path.join(baseDir, "ai-settings.json");
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 2,
      cooldownSec: 0,
      dryRun: true,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.ai.enabled = true;
  config.ai.settingsFile = settingsFile;
  config.execution.maxWindows = 1;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 3);
  const symbols = system.calls.args.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["BTC_KRW", "ETH_KRW", "USDT_KRW"]);
});
