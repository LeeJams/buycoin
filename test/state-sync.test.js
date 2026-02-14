import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES } from "../src/config/exit-codes.js";
import { StateSync } from "../src/core/state-sync.js";
import { createTempStore } from "../test-utils/helpers.js";

class ExchangeSyncMock {
  constructor({ accounts = [], failAccounts = false } = {}) {
    this.accessKey = "mock-access";
    this.secretKey = "mock-secret";
    this.accounts = accounts;
    this.failAccounts = failAccounts;
  }

  async getAccounts() {
    if (this.failAccounts) {
      throw new Error("account sync failed");
    }
    return this.accounts;
  }

  async getOrderStatus() {
    return null;
  }
}

class ExchangeFallbackLookupMock {
  constructor() {
    this.accessKey = "mock-access";
    this.secretKey = "mock-secret";
  }

  async getAccounts() {
    return [];
  }

  async getOrderStatus({ exchangeOrderId, clientOrderKey }) {
    if (!exchangeOrderId && clientOrderKey === "fallback-key-1") {
      return {
        uuid: "ex-order-1",
        state: "done",
        executed_volume: "3.4",
        remaining_volume: "0",
        _lookupSource: "fallback-mock",
      };
    }
    return null;
  }
}

test("state sync stores balance snapshot during reconcile", async () => {
  const { store } = await createTempStore();
  const sync = new StateSync(
    store,
    new ExchangeSyncMock({
      accounts: [{ currency: "USDT", unit_currency: "KRW", balance: "5", locked: "0" }],
    }),
    console,
  );

  const result = await sync.reconcile();
  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.accountSync.attempted, true);
  assert.equal(result.data.accountSync.ok, true);
  assert.equal(result.data.accountSync.count, 1);

  const snapshot = store.snapshot().balancesSnapshot.at(-1);
  assert.equal(snapshot.source, "reconcile");
  assert.equal(snapshot.items.length, 1);
});

test("state sync reports mismatch when account sync fails", async () => {
  const { store } = await createTempStore();
  const sync = new StateSync(store, new ExchangeSyncMock({ failAccounts: true }), console);

  const result = await sync.reconcile();
  assert.equal(result.ok, false);
  assert.equal(result.code, EXIT_CODES.RECONCILE_MISMATCH);
  assert.equal(result.error.type, "RECONCILE_MISMATCH");
  assert.equal(result.error.details.accountSync.attempted, true);
  assert.equal(result.error.details.accountSync.ok, false);
  assert.equal(typeof result.error.details.accountSync.error, "string");
});

test("state sync updates UNKNOWN_SUBMIT without exchangeOrderId via fallback lookup", async () => {
  const { store } = await createTempStore();
  await store.update((state) => {
    state.orders.push({
      id: "unknown-fallback-1",
      clientOrderKey: "fallback-key-1",
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

  const sync = new StateSync(store, new ExchangeFallbackLookupMock(), console);
  const result = await sync.reconcile();
  assert.equal(result.ok, true);
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.data.unknownOrders, 1);
  assert.equal(result.data.resolvedUnknownOrders, 1);
  assert.equal(result.data.fallbackLookups, 1);

  const order = store.findOrderById("unknown-fallback-1");
  assert.equal(order.state, "FILLED");
  assert.equal(order.exchangeOrderId, "ex-order-1");
  assert.equal(order.remainingQty, 0);
});
