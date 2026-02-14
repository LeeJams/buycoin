import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES } from "../src/config/exit-codes.js";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";

test("trader health is HEALTHY on clean state", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, { store });
  await service.init();

  const result = await service.health();
  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.summary.status, "HEALTHY");
});

test("trader health degrades on fresh UNKNOWN_SUBMIT and fails in strict mode", async () => {
  const { config, store } = await createTempStore();
  config.resilience.unknownSubmitMaxAgeSec = 300;
  await store.update((state) => {
    state.orders.push({
      id: "unknown-1",
      clientOrderKey: "unknown-key-1",
      exchangeOrderId: null,
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      amountKrw: 5000,
      qty: 3.40831629,
      remainingQty: 3.40831629,
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId: "manual",
      paper: true,
      state: "UNKNOWN_SUBMIT",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return state;
  });

  const service = new TraderService(config, { store });
  await service.init();

  const degraded = await service.health();
  assert.equal(degraded.ok, true);
  assert.equal(degraded.data.summary.status, "DEGRADED");

  const strict = await service.health({ strict: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, EXIT_CODES.RECONCILE_MISMATCH);
  assert.equal(strict.error.type, "SYSTEM_HEALTH_FAILED");
});

test("trader health is UNHEALTHY on aged UNKNOWN_SUBMIT", async () => {
  const { config, store } = await createTempStore();
  config.resilience.unknownSubmitMaxAgeSec = 1;
  const oldTs = new Date(Date.now() - 5_000).toISOString();

  await store.update((state) => {
    state.orders.push({
      id: "unknown-2",
      clientOrderKey: "unknown-key-2",
      exchangeOrderId: null,
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      amountKrw: 5000,
      qty: 3.40831629,
      remainingQty: 3.40831629,
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId: "manual",
      paper: true,
      state: "UNKNOWN_SUBMIT",
      createdAt: oldTs,
      updatedAt: oldTs,
    });
    return state;
  });

  const service = new TraderService(config, { store });
  await service.init();

  const result = await service.health();
  assert.equal(result.ok, false);
  assert.equal(result.code, EXIT_CODES.RECONCILE_MISMATCH);
  assert.equal(result.error.details.summary.status, "UNHEALTHY");
});

test("trader health warns on live open order without exchangeOrderId", async () => {
  const { config, store } = await createTempStore();
  await store.update((state) => {
    state.orders.push({
      id: "live-missing-ex-id-1",
      clientOrderKey: "live-missing-ex-id-key-1",
      exchangeOrderId: null,
      symbol: "USDT_KRW",
      side: "sell",
      type: "limit",
      price: 1468,
      amountKrw: 7335,
      qty: 5,
      remainingQty: 5,
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId: "manual",
      paper: false,
      state: "ACCEPTED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return state;
  });

  const service = new TraderService(config, { store });
  await service.init();

  const result = await service.health();
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.status, "DEGRADED");
  const check = result.data.checks.find((item) => item.name === "open_orders_missing_exchange_id");
  assert.equal(check.status, "WARN");
  assert.equal(check.detail.count, 1);

  const strict = await service.health({ strict: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, EXIT_CODES.RECONCILE_MISMATCH);
});
