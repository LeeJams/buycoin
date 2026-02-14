import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runCli(args, envOverrides = {}) {
  const cliPath = path.join(process.cwd(), "src", "cli", "index.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...envOverrides,
    },
  });

  const stdout = String(result.stdout || "").trim();
  const line = stdout.split("\n").filter(Boolean).at(-1) || "";
  const payload = line ? JSON.parse(line) : null;
  return {
    code: result.status,
    payload,
    stdout,
    stderr: String(result.stderr || ""),
  };
}

test("cli returns INVALID_ARGS for missing required flags", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(["order", "place", "--side", "buy", "--type", "limit", "--price", "100", "--amount", "100", "--json"], {
    TRADER_STATE_FILE: stateFile,
  });

  assert.equal(res.code, 2);
  assert.equal(res.payload.code, 2);
  assert.equal(res.payload.error.type, "INVALID_ARGUMENT");
  assert.equal(res.payload.error.retryable, false);
  assert.equal(res.payload.error.details.field, "symbol");
});

test("cli returns INVALID_ARGS for invalid numeric option", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(
    [
      "order",
      "place",
      "--symbol",
      "BTC_KRW",
      "--side",
      "buy",
      "--type",
      "limit",
      "--price",
      "bad",
      "--amount",
      "100",
      "--json",
    ],
    { TRADER_STATE_FILE: stateFile },
  );

  assert.equal(res.code, 2);
  assert.equal(res.payload.code, 2);
  assert.equal(res.payload.error.type, "INVALID_ARGUMENT");
  assert.equal(res.payload.error.retryable, false);
  assert.equal(res.payload.error.details.reason, "invalid_number");
});

test("cli idempotency key returns existing order on retry", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const key = "agent-retry-key-1";
  const args = [
    "order",
    "place",
    "--symbol",
    "BTC_KRW",
    "--side",
    "buy",
    "--type",
    "limit",
    "--price",
    "6000",
    "--amount",
    "6000",
    "--client-order-key",
    key,
    "--json",
  ];

  const first = runCli(args, { TRADER_STATE_FILE: stateFile, TRADER_PAPER_MODE: "true" });
  const second = runCli(args, { TRADER_STATE_FILE: stateFile, TRADER_PAPER_MODE: "true" });

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.payload.data.id, first.payload.data.id);
  assert.equal(second.payload.data.idempotentHit, true);
});

test("cli idempotency replay bypasses risk-limit rejection", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const key = "agent-retry-key-2";
  const args = [
    "order",
    "place",
    "--symbol",
    "BTC_KRW",
    "--side",
    "buy",
    "--type",
    "limit",
    "--price",
    "6000",
    "--amount",
    "6000",
    "--client-order-key",
    key,
    "--json",
  ];
  const env = {
    TRADER_STATE_FILE: stateFile,
    TRADER_PAPER_MODE: "true",
    RISK_MAX_CONCURRENT_ORDERS: "1",
  };

  const first = runCli(args, env);
  const second = runCli(args, env);

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.payload.data.id, first.payload.data.id);
  assert.equal(second.payload.data.idempotentHit, true);
});

test("cli rejects order below minimum notional with risk code", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(
    [
      "order",
      "place",
      "--symbol",
      "USDT_KRW",
      "--side",
      "buy",
      "--type",
      "limit",
      "--price",
      "1468",
      "--amount",
      "1468",
      "--json",
    ],
    {
      TRADER_STATE_FILE: stateFile,
      TRADER_PAPER_MODE: "true",
      RISK_MIN_ORDER_NOTIONAL_KRW: "5000",
    },
  );

  assert.equal(res.code, 3);
  assert.equal(res.payload.code, 3);
  assert.equal(res.payload.error.type, "RISK_REJECTED");
  assert.equal(res.payload.error.retryable, false);
  assert.equal(
    res.payload.error.details.reasons.some((item) => item.rule === "MIN_ORDER_NOTIONAL_KRW"),
    true,
  );
});

test("cli resolves UNKNOWN_SUBMIT with order unknown force-close", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const env = {
    TRADER_STATE_FILE: stateFile,
  };

  const init = runCli(["status", "--json"], env);
  assert.equal(init.code, 0);

  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  raw.orders.push({
    id: "cli-unknown-1",
    clientOrderKey: "cli-unknown-key-1",
    exchangeOrderId: null,
    symbol: "USDT_KRW",
    side: "buy",
    type: "limit",
    price: 1467,
    amountKrw: 5000,
    qty: 3.4,
    remainingQty: 3.4,
    filledQty: 0,
    avgFillPrice: null,
    strategyRunId: "manual",
    paper: false,
    state: "UNKNOWN_SUBMIT",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    correlationId: "cli-unknown-corr-1",
  });
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), "utf8");

  const res = runCli(
    ["order", "unknown", "--id", "cli-unknown-1", "--action", "force-close", "--reason", "manual", "--json"],
    env,
  );

  assert.equal(res.code, 0);
  assert.equal(res.payload.code, 0);
  assert.equal(res.payload.data.resolvedCount, 1);

  const after = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const target = after.orders.find((item) => item.id === "cli-unknown-1");
  assert.equal(target.state, "CANCELED");
});

test("cli supports account list command shape", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(["account", "list", "--json"], {
    TRADER_STATE_FILE: stateFile,
    BITHUMB_ACCESS_KEY: "",
    BITHUMB_SECRET_KEY: "",
  });

  assert.equal(res.code, 6);
  assert.equal(res.payload.code, 6);
  assert.equal(res.payload.error.type, "EXCHANGE_FATAL");
  assert.equal(typeof res.payload.error.message, "string");
});

test("cli candles rejects unsupported interval with INVALID_ARGUMENT", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(
    ["candles", "--symbol", "USDT_KRW", "--interval", "2m", "--count", "10", "--json"],
    { TRADER_STATE_FILE: stateFile },
  );

  assert.equal(res.code, 2);
  assert.equal(res.payload.code, 2);
  assert.equal(res.payload.error.type, "INVALID_ARGUMENT");
  assert.equal(res.payload.error.details.field, "interval");
});

test("cli health reports HEALTHY in clean state", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(["health", "--json"], {
    TRADER_STATE_FILE: stateFile,
  });

  assert.equal(res.code, 0);
  assert.equal(res.payload.code, 0);
  assert.equal(res.payload.data.summary.status, "HEALTHY");
});

test("cli health returns kill-switch code when strict and kill-switch is on", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const env = {
    TRADER_STATE_FILE: stateFile,
    TRADER_PAPER_MODE: "true",
  };

  const on = runCli(["kill-switch", "on", "--reason", "health-test", "--json"], env);
  const health = runCli(["health", "--strict", "--json"], env);

  assert.equal(on.code, 0);
  assert.equal(health.code, 9);
  assert.equal(health.payload.code, 9);
  assert.equal(health.payload.error.type, "SYSTEM_HEALTH_FAILED");
  assert.equal(health.payload.error.details.summary.status, "UNHEALTHY");
});

test("cli supports market buy with amount only (no price flag)", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(
    ["order", "place", "--symbol", "USDT_KRW", "--side", "buy", "--type", "market", "--amount", "5000", "--json"],
    { TRADER_STATE_FILE: stateFile, TRADER_PAPER_MODE: "true" },
  );

  assert.equal(res.code, 0);
  assert.equal(res.payload.code, 0);
  assert.equal(res.payload.data.price, 5000);
  assert.equal(res.payload.data.qty, 1);
});

test("cli order list rejects using state and states together", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-contract-"));
  const stateFile = path.join(baseDir, "state.json");
  const res = runCli(
    ["order", "list", "--symbol", "USDT_KRW", "--state", "wait", "--states", "wait,done", "--json"],
    { TRADER_STATE_FILE: stateFile },
  );

  assert.equal(res.code, 2);
  assert.equal(res.payload.code, 2);
  assert.equal(res.payload.error.type, "INVALID_ARGUMENT");
  assert.equal(res.payload.error.details.reason, "mutually_exclusive");
});
