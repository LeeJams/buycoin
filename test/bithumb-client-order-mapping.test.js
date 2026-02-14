import test from "node:test";
import assert from "node:assert/strict";
import { BithumbClient } from "../src/exchange/bithumb-client.js";
import { loadConfig } from "../src/config/defaults.js";

function makeClient() {
  const config = loadConfig({
    BITHUMB_ACCESS_KEY: "test-access",
    BITHUMB_SECRET_KEY: "test-secret",
    BITHUMB_MAX_RETRIES: "0",
  });
  return new BithumbClient(config, console);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("bithumb client maps limit order body to ord_type=limit with price+volume", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ uuid: "limit-order-id" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      qty: 3.4,
      amountKrw: 5000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.market, "KRW-USDT");
  assert.equal(body.side, "bid");
  assert.equal(body.ord_type, "limit");
  assert.equal(body.price, "1467");
  assert.equal(body.volume, "3.4");
  assert.equal("order_type" in body, false);
});

test("bithumb client maps market buy to ord_type=price with only price field", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ uuid: "market-buy-id" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "buy",
      type: "market",
      price: 1467,
      qty: 3.4,
      amountKrw: 5000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.market, "KRW-USDT");
  assert.equal(body.side, "bid");
  assert.equal(body.ord_type, "price");
  assert.equal(body.price, "5000");
  assert.equal("volume" in body, false);
});

test("bithumb client maps market sell to ord_type=market with only volume field", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ uuid: "market-sell-id" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "sell",
      type: "market",
      price: 1467,
      qty: 5,
      amountKrw: 7335,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.market, "KRW-USDT");
  assert.equal(body.side, "ask");
  assert.equal(body.ord_type, "market");
  assert.equal(body.volume, "5");
  assert.equal("price" in body, false);
});

test("bithumb client includes identifier when clientOrderKey is provided", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ uuid: "limit-order-id" });
  };

  try {
    await client.placeOrder({
      symbol: "USDT_KRW",
      side: "buy",
      type: "limit",
      price: 1467,
      qty: 3.4,
      amountKrw: 5000,
      clientOrderKey: "client-key-123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.identifier, "client-key-123");
});

test("bithumb client getOrderStatus resolves by orders list when only clientOrderKey is available", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);

    if (target.includes("/v1/orders") && target.includes("state=done")) {
      return jsonResponse([
        {
          uuid: "fallback-order-1",
          market: "KRW-USDT",
          state: "done",
        },
      ]);
    }
    if (target.includes("/v1/orders") || target.includes("/v2/orders")) {
      return jsonResponse([]);
    }
    return jsonResponse({ message: "not found" }, 404);
  };

  try {
    const status = await client.getOrderStatus({
      symbol: "USDT_KRW",
      clientOrderKey: "client-key-fallback",
    });

    assert.equal(status.uuid, "fallback-order-1");
    assert.equal(String(status._lookupSource).includes("orders:list"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const paths = calls.map((item) => new URL(item).pathname);
  assert.equal(paths.includes("/v1/orders"), true);
  assert.equal(calls.some((item) => item.includes("state=done")), true);
  assert.equal(paths.includes("/v1/order"), false);
  assert.equal(paths.includes("/v2/order"), false);
});

test("bithumb client calls /v1/orders/chance with market query", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse({ market: { id: "KRW-USDT" } });
  };

  try {
    await client.getOrderChance({
      symbol: "USDT_KRW",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const target = new URL(calls[0]);
  assert.equal(target.pathname, "/v1/orders/chance");
  assert.equal(target.searchParams.get("market"), "KRW-USDT");
});

test("bithumb client listOrders maps v1 query fields", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse([]);
  };

  try {
    await client.listOrders({
      symbol: "USDT_KRW",
      uuids: ["u1", "u2"],
      states: ["wait", "done"],
      page: 2,
      limit: 10,
      orderBy: "asc",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const target = new URL(calls[0]);
  assert.equal(target.pathname, "/v1/orders");
  assert.equal(target.searchParams.get("market"), "KRW-USDT");
  assert.deepEqual(target.searchParams.getAll("uuids"), ["u1", "u2"]);
  assert.deepEqual(target.searchParams.getAll("states"), ["wait", "done"]);
  assert.equal(target.searchParams.get("page"), "2");
  assert.equal(target.searchParams.get("limit"), "10");
  assert.equal(target.searchParams.get("order_by"), "asc");
});

test("bithumb client getOrder maps uuid query", async () => {
  const client = makeClient();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse({ uuid: "order-1" });
  };

  try {
    await client.getOrder({
      exchangeOrderId: "order-1",
      symbol: "USDT_KRW",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const target = new URL(calls[0]);
  assert.equal(target.pathname, "/v1/order");
  assert.equal(target.searchParams.get("uuid"), "order-1");
  assert.equal(target.searchParams.get("market"), "KRW-USDT");
});
