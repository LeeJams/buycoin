import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  BithumbPublicWsClient,
  parseMyAssetFrame,
  parseMyOrderFrame,
  parseOrderbookFrame,
  parseTickerFrame,
  parseTradeFrame,
} from "../src/exchange/bithumb-public-ws.js";

class FakeWs extends EventEmitter {
  constructor(url, options = null) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    queueMicrotask(() => {
      this.readyState = this.OPEN;
      this.emit("open");
    });
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = this.CLOSED;
    this.emit("close", { code: 1000, reason: "closed" });
  }
}

function baseConfig() {
  return {
    exchange: {
      wsPublicUrl: "wss://ws-api.bithumb.com/websocket/v1",
      wsPrivateUrl: "wss://ws-api.bithumb.com/websocket/v1/private",
      wsConnectMaxPerSec: 10,
      accessKey: "access-key",
      secretKey: "secret-key",
    },
  };
}

test("parseTickerFrame supports DEFAULT fields", () => {
  const frame = parseTickerFrame({
    type: "ticker",
    code: "KRW-BTC",
    trade_price: 12345,
    stream_type: "REALTIME",
    timestamp: 1700000000000,
  });

  assert.equal(frame.symbol, "BTC_KRW");
  assert.equal(frame.tradePrice, 12345);
  assert.equal(frame.streamType, "REALTIME");
});

test("parseTickerFrame supports SIMPLE fields", () => {
  const frame = parseTickerFrame({
    ty: "ticker",
    cd: "KRW-ETH",
    tp: 4567,
    st: "REALTIME",
    tms: 1700000000001,
  });

  assert.equal(frame.symbol, "ETH_KRW");
  assert.equal(frame.tradePrice, 4567);
});

test("parseTradeFrame supports DEFAULT fields", () => {
  const frame = parseTradeFrame({
    type: "trade",
    code: "KRW-BTC",
    trade_price: 12345,
    trade_volume: 0.12,
    ask_bid: "ASK",
    sequential_id: 111,
    timestamp: 1700000000002,
  });

  assert.equal(frame.symbol, "BTC_KRW");
  assert.equal(frame.tradePrice, 12345);
  assert.equal(frame.tradeVolume, 0.12);
  assert.equal(frame.askBid, "ASK");
  assert.equal(frame.sequentialId, 111);
});

test("parseOrderbookFrame supports SIMPLE fields", () => {
  const frame = parseOrderbookFrame({
    ty: "orderbook",
    cd: "KRW-ETH",
    tas: 12.34,
    tbs: 45.67,
    obu: [
      { ap: 3000, bp: 2990, as: 1.2, bs: 0.8 },
    ],
    lv: 1,
    tms: 1700000000003,
    st: "REALTIME",
  });

  assert.equal(frame.symbol, "ETH_KRW");
  assert.equal(frame.totalAskSize, 12.34);
  assert.equal(frame.totalBidSize, 45.67);
  assert.equal(frame.units.length, 1);
  assert.equal(frame.units[0].askPrice, 3000);
  assert.equal(frame.level, 1);
});

test("parseMyOrderFrame supports SIMPLE fields", () => {
  const frame = parseMyOrderFrame({
    ty: "myOrder",
    cd: "KRW-BTC",
    uid: "order-uuid",
    ab: "BID",
    ot: "limit",
    s: "wait",
    p: 100000000,
    v: 0.01,
    st: "REALTIME",
    tms: 1700000000004,
  });

  assert.equal(frame.symbol, "BTC_KRW");
  assert.equal(frame.uuid, "order-uuid");
  assert.equal(frame.askBid, "BID");
  assert.equal(frame.orderType, "limit");
});

test("parseMyAssetFrame supports SIMPLE fields", () => {
  const frame = parseMyAssetFrame({
    ty: "myAsset",
    ast: [
      { cu: "KRW", b: 1000, l: 0 },
      { cu: "BTC", b: 0.01, l: 0.002 },
    ],
    asttms: 1700000000005,
    st: "REALTIME",
    tms: 1700000000006,
  });

  assert.equal(frame.assets.length, 2);
  assert.equal(frame.assets[0].currency, "KRW");
  assert.equal(frame.assets[1].currency, "BTC");
  assert.equal(frame.assetTimestamp, 1700000000005);
});

test("openTickerStream sends proper Bithumb subscription array", async () => {
  let wsInstance = null;
  function WebSocketCtor(url) {
    wsInstance = new FakeWs(url);
    return wsInstance;
  }

  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor });
  const stream = await client.openTickerStream({
    symbols: ["BTC_KRW"],
    isOnlyRealtime: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wsInstance.url, "wss://ws-api.bithumb.com/websocket/v1");
  assert.equal(wsInstance.sent.length, 1);

  const payload = JSON.parse(wsInstance.sent[0]);
  assert.equal(Array.isArray(payload), true);
  assert.equal(payload[1].type, "ticker");
  assert.deepEqual(payload[1].codes, ["KRW-BTC"]);
  assert.equal(payload[1].isOnlyRealtime, true);

  stream.close();
  await stream.closed;
});

test("openTradeStream sends trade subscription", async () => {
  let wsInstance = null;
  function WebSocketCtor(url, options) {
    wsInstance = new FakeWs(url, options);
    return wsInstance;
  }

  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor });
  const stream = await client.openTradeStream({
    symbols: ["BTC_KRW"],
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(wsInstance.sent[0]);
  assert.equal(payload[1].type, "trade");
  assert.deepEqual(payload[1].codes, ["KRW-BTC"]);

  stream.close();
  await stream.closed;
});

test("openOrderbookStream sends orderbook level", async () => {
  let wsInstance = null;
  function WebSocketCtor(url, options) {
    wsInstance = new FakeWs(url, options);
    return wsInstance;
  }

  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor });
  const stream = await client.openOrderbookStream({
    symbols: ["ETH_KRW"],
    level: 1,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(wsInstance.sent[0]);
  assert.equal(payload[1].type, "orderbook");
  assert.equal(payload[1].level, 1);
  assert.deepEqual(payload[1].codes, ["KRW-ETH"]);

  stream.close();
  await stream.closed;
});

test("openMyOrderStream uses private endpoint with auth header", async () => {
  let wsInstance = null;
  function WebSocketCtor(url, options) {
    wsInstance = new FakeWs(url, options);
    return wsInstance;
  }

  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor, PrivateWebSocketCtor: WebSocketCtor });
  const stream = await client.openMyOrderStream({
    symbols: ["BTC_KRW"],
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wsInstance.url, "wss://ws-api.bithumb.com/websocket/v1/private");
  assert.equal(typeof wsInstance.options?.headers?.authorization, "string");
  assert.equal(wsInstance.options.headers.authorization.startsWith("Bearer "), true);

  const payload = JSON.parse(wsInstance.sent[0]);
  assert.equal(payload[1].type, "myOrder");
  assert.deepEqual(payload[1].codes, ["KRW-BTC"]);

  stream.close();
  await stream.closed;
});

test("openMyAssetStream sends private myAsset subscription without codes", async () => {
  let wsInstance = null;
  function WebSocketCtor(url, options) {
    wsInstance = new FakeWs(url, options);
    return wsInstance;
  }

  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor, PrivateWebSocketCtor: WebSocketCtor });
  const stream = await client.openMyAssetStream();

  await new Promise((resolve) => setTimeout(resolve, 0));
  const payload = JSON.parse(wsInstance.sent[0]);
  assert.equal(payload[1].type, "myAsset");
  assert.equal("codes" in payload[1], false);

  stream.close();
  await stream.closed;
});

test("openTickerStream surfaces documented websocket error payload", async () => {
  let wsInstance = null;
  function WebSocketCtor(url) {
    wsInstance = new FakeWs(url);
    return wsInstance;
  }

  const errors = [];
  const statuses = [];
  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor });
  const stream = await client.openTickerStream({
    symbols: ["BTC_KRW"],
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  wsInstance.emit("message", {
    data: JSON.stringify({
      error: {
        name: "NO_TYPE",
        message: "type 필드가 존재하지 않습니다.",
      },
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "NO_TYPE");
  assert.equal(errors[0].message.includes("type 필드가 존재하지 않습니다."), true);
  assert.equal(statuses.some((s) => s.event === "error"), true);

  stream.close();
  await stream.closed;
});

test("openTickerStream treats non-0000 status as error", async () => {
  let wsInstance = null;
  function WebSocketCtor(url) {
    wsInstance = new FakeWs(url);
    return wsInstance;
  }

  const errors = [];
  const client = new BithumbPublicWsClient(baseConfig(), null, { WebSocketCtor });
  const stream = await client.openTickerStream({
    symbols: ["BTC_KRW"],
    onError: (error) => errors.push(error),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  wsInstance.emit("message", {
    data: JSON.stringify({
      status: "5100",
      resmsg: "Invalid filter",
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "WS_STATUS_ERROR");
  assert.equal(errors[0].status, "5100");

  stream.close();
  await stream.closed;
});
