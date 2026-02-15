import test from "node:test";
import assert from "node:assert/strict";
import { BithumbClient } from "../src/exchange/bithumb-client.js";

function response(status, payload = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      if (payload === null) {
        return "";
      }
      return JSON.stringify(payload);
    },
  };
}

function createClient() {
  return new BithumbClient(
    {
      exchange: {
        baseUrl: "https://api.bithumb.com",
        accessKey: "access",
        secretKey: "secret",
        timeoutMs: 5000,
        maxRetries: 0,
        retryBaseMs: 1,
        publicMaxPerSec: 150,
        privateMaxPerSec: 140,
      },
    },
    {
      info() {},
      warn() {},
      error() {},
    },
  );
}

test("placeOrder uses documented v1/orders first and maps market buy payload", async () => {
  const client = createClient();
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return response(200, { uuid: "u-1" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "buy",
      type: "market",
      amountKrw: 7000,
      clientOrderKey: "k-market-buy",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.bithumb.com/v1/orders");
  assert.equal(calls[0].options.method, "POST");

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.market, "KRW-USDT");
  assert.equal(body.side, "bid");
  assert.equal(body.ord_type, "price");
  assert.equal(body.price, "7000");
  assert.equal(body.identifier, "k-market-buy");
  assert.equal("volume" in body, false);
});

test("placeOrder falls back to v2/orders when v1/orders is unavailable", async () => {
  const client = createClient();
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return response(404, { message: "not found" });
    }
    return response(200, { uuid: "u-2" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "sell",
      type: "market",
      price: 1468,
      qty: 2.5,
      clientOrderKey: "k-market-sell",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.bithumb.com/v1/orders");
  assert.equal(calls[1].url, "https://api.bithumb.com/v2/orders");
});

test("cancelOrder uses documented v1/order first and falls back to v2/order", async () => {
  const client = createClient();
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return response(405, { message: "method not allowed" });
    }
    return response(200, { uuid: "order-1", state: "cancel" });
  };

  try {
    await client.cancelOrder({
      exchangeOrderId: "order-1",
      symbol: "USDT_KRW",
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[1].options.method, "DELETE");
  assert.equal(calls[0].url, "https://api.bithumb.com/v1/order?uuid=order-1");
  assert.equal(calls[1].url, "https://api.bithumb.com/v2/order?uuid=order-1&market=KRW-USDT");
});
