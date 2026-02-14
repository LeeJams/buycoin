import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES } from "../src/config/exit-codes.js";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";

async function seedUnknownOrder(store, { id, clientOrderKey }) {
  await store.update((state) => {
    state.orders.push({
      id,
      clientOrderKey,
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
    });
    return state;
  });
}

test("unknown cleanup force-close changes UNKNOWN_SUBMIT to CANCELED", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, { store });
  await service.init();
  await seedUnknownOrder(store, { id: "unknown-cleanup-1", clientOrderKey: "cleanup-key-1" });

  const result = await service.resolveUnknownSubmitOrders({
    action: "force-close",
    orderId: "unknown-cleanup-1",
    reason: "manual_cleanup",
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.resolvedCount, 1);
  assert.equal(store.findOrderById("unknown-cleanup-1").state, "CANCELED");
});

test("unknown cleanup mark-rejected resolves by client order key", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, { store });
  await service.init();
  await seedUnknownOrder(store, { id: "unknown-cleanup-2", clientOrderKey: "cleanup-key-2" });

  const result = await service.resolveUnknownSubmitOrders({
    action: "mark-rejected",
    clientOrderKey: "cleanup-key-2",
  });

  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.resolvedCount, 1);
  assert.equal(store.findOrderById("unknown-cleanup-2").state, "REJECTED");
});

test("unknown cleanup returns INVALID_ARGS when target is not UNKNOWN_SUBMIT", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, { store });
  await service.init();
  await store.update((state) => {
    state.orders.push({
      id: "unknown-cleanup-3",
      clientOrderKey: "cleanup-key-3",
      exchangeOrderId: "ex-3",
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      amountKrw: 5000,
      qty: 3.4,
      remainingQty: 0,
      filledQty: 3.4,
      avgFillPrice: 1467,
      strategyRunId: "manual",
      paper: false,
      state: "FILLED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return state;
  });

  const result = await service.resolveUnknownSubmitOrders({
    action: "force-close",
    orderId: "unknown-cleanup-3",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, EXIT_CODES.INVALID_ARGS);
});
