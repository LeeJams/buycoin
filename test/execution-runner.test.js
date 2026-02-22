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
    runtime: {},
    exchange: {
      accessKey: "",
      secretKey: "",
    },
    ai: {
      enabled: false,
      settingsFile: null,
      applyOverlay: true,
      applyKillSwitch: true,
      refreshMinSec: 1800,
      refreshMaxSec: 3600,
    },
    execution: {
      enabled: true,
      symbol: "BTC_KRW",
      symbols: ["BTC_KRW"],
      orderAmountKrw: 20000,
      windowSec: 1,
      cooldownSec: 1,
      restartDelayMs: 1,
    },
  };
}

test("execution service runs realtime windows by stopAfterWindows", async () => {
  const config = baseConfig();
  const system = new SystemMock();

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 2);
  assert.equal(result.stoppedBy, "window_limit");
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

  const system = new SystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.strategyApply, 1);
  assert.equal(system.calls.realtime, 1);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 20000);
  assert.equal(system.calls.args[0].durationSec, 5);
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
    },
    decision: {
      mode: "override",
      forceAction: "buy",
      forceAmountKrw: 6500,
      symbols: {
        "ETH_KRW": {
          mode: "filter",
          allowBuy: false,
          allowSell: true,
        },
      },
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(payload, null, 2), "utf8");

  const config = baseConfig();
  config.ai.enabled = true;
  config.ai.settingsFile = settingsFile;

  const system = new SystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 3);
  const symbols = system.calls.args.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["BTC_KRW", "ETH_KRW", "USDT_KRW"]);
  const bySymbol = Object.fromEntries(system.calls.args.map((row) => [row.symbol, row.executionPolicy]));
  assert.equal(bySymbol.BTC_KRW.mode, "override");
  assert.equal(bySymbol.BTC_KRW.forceAction, "BUY");
  assert.equal(bySymbol.BTC_KRW.forceAmountKrw, 20000);
  assert.equal(bySymbol.ETH_KRW.mode, "filter");
  assert.equal(bySymbol.ETH_KRW.allowBuy, false);
  assert.equal(bySymbol.ETH_KRW.allowSell, true);
});

test("execution service keeps ai snapshot until refresh window", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "execution-ai-refresh-"));
  const settingsFile = path.join(baseDir, "ai-settings.json");
  const firstPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "USDT_KRW",
      symbols: ["USDT_KRW"],
      orderAmountKrw: 7000,
      windowSec: 1,
      cooldownSec: 0,
    },
  };
  const secondPayload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    execution: {
      enabled: true,
      symbol: "ETH_KRW",
      symbols: ["ETH_KRW"],
      orderAmountKrw: 9000,
      windowSec: 1,
      cooldownSec: 0,
    },
  };
  await fs.writeFile(settingsFile, JSON.stringify(firstPayload, null, 2), "utf8");

  class MutatingSystemMock extends SystemMock {
    async runStrategyRealtime(args) {
      this.calls.realtime += 1;
      this.calls.args.push(args);
      if (this.calls.realtime === 1) {
        await fs.writeFile(settingsFile, JSON.stringify(secondPayload, null, 2), "utf8");
      }
      return this.result;
    }
  }

  const config = baseConfig();
  config.ai.enabled = true;
  config.ai.settingsFile = settingsFile;
  config.ai.refreshMinSec = 3600;
  config.ai.refreshMaxSec = 3600;

  const system = new MutatingSystemMock();
  const result = await runExecutionService({ system, config, stopAfterWindows: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 2);
  assert.equal(system.calls.realtime, 2);
  assert.equal(system.calls.args[0].symbol, "USDT_KRW");
  assert.equal(system.calls.args[1].symbol, "USDT_KRW");
  assert.equal(system.calls.args[0].amount, 20000);
  assert.equal(system.calls.args[1].amount, 20000);
});

test("execution service applies market universe filter to requested symbols", async () => {
  const config = baseConfig();
  config.execution.symbols = ["BTC_KRW", "ETH_KRW", "USDT_KRW"];

  const system = new SystemMock();
  const universe = {
    enabled: true,
    async init() {},
    async maybeRefresh() {
      return {
        ok: true,
        data: {
          symbols: ["BTC_KRW", "USDT_KRW"],
          criteria: { minAccTradeValue24hKrw: 1 },
          nextRefreshSec: 1800,
        },
      };
    },
    filterSymbols(symbols = []) {
      const allowed = new Set(["BTC_KRW", "USDT_KRW"]);
      const accepted = [];
      const rejected = [];
      for (const symbol of symbols) {
        if (allowed.has(symbol)) {
          accepted.push(symbol);
        } else {
          rejected.push(symbol);
        }
      }
      return {
        symbols: accepted,
        filteredOut: rejected,
        allowedCount: allowed.size,
        source: "mock",
      };
    },
  };

  const result = await runExecutionService({
    system,
    config,
    stopAfterWindows: 1,
    marketUniverseService: universe,
  });

  assert.equal(result.ok, true);
  assert.equal(result.windows, 1);
  assert.equal(system.calls.realtime, 2);
  const symbols = system.calls.args.map((row) => row.symbol).sort();
  assert.deepEqual(symbols, ["BTC_KRW", "USDT_KRW"]);
});
