import test from "node:test";
import assert from "node:assert/strict";
import { TraderService } from "../src/core/trader-service.js";
import { createTempStore } from "../test-utils/helpers.js";

class ExchangeAccountsMock {
  constructor(response) {
    this.response = response;
  }

  isRetryableError() {
    return false;
  }

  async getAccounts() {
    return this.response;
  }
}

test("trader service account list returns normalized balances and stores snapshot", async () => {
  const { config, store } = await createTempStore();
  const service = new TraderService(config, {
    store,
    exchangeClient: new ExchangeAccountsMock([
      { currency: "BTC", unit_currency: "KRW", balance: "0.25", locked: "0.01" },
      { currency: "USDT", unit_currency: "KRW", balance: "123.45", locked: "0" },
    ]),
  });
  await service.init();

  const res = await service.listAccounts();
  assert.equal(res.ok, true);
  assert.equal(res.data.count, 2);
  assert.equal(res.data.accounts[0].symbol, "BTC_KRW");
  assert.equal(res.data.accounts[0].balance, 0.25);
  assert.equal(res.data.accounts[1].symbol, "USDT_KRW");

  const state = store.snapshot();
  assert.equal(state.balancesSnapshot.length > 0, true);
  assert.equal(state.balancesSnapshot.at(-1).items.length, 2);
});
