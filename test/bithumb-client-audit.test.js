import test from "node:test";
import assert from "node:assert/strict";
import { BithumbClient } from "../src/exchange/bithumb-client.js";

function createClient(events) {
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
    {
      onRequestEvent: (event) => events.push(event),
      nowFn: (() => {
        let now = 1000;
        return () => {
          now += 5;
          return now;
        };
      })(),
    },
  );
}

test("bithumb client emits request audit event for successful request", async () => {
  const events = [];
  const client = createClient(events);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify([{ currency: "KRW", balance: "1" }]);
    },
  });

  try {
    await client.getAccounts();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/accounts");
  assert.equal(events[0].requiresAuth, true);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].retryable, false);
  assert.equal(events[0].attempt, 1);
  assert.equal(typeof events[0].durationMs, "number");
});

test("bithumb client emits request audit event for failed request", async () => {
  const events = [];
  const client = createClient(events);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return JSON.stringify({ message: "server error" });
    },
  });

  try {
    await assert.rejects(client.getAccounts());
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/accounts");
  assert.equal(events[0].ok, false);
  assert.equal(events[0].status, 500);
  assert.equal(events[0].retryable, true);
  assert.equal(events[0].error, "server error");
  assert.equal(events[0].attempt, 1);
});
