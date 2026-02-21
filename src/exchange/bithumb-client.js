import crypto from "node:crypto";
import { toBithumbMarket } from "../config/defaults.js";
import { uuid } from "../lib/ids.js";
import { PerSecondSlidingWindowLimiter } from "./rate-limiter.js";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hmacSha256(secret, message) {
  return crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha512Hex(message) {
  return crypto.createHash("sha512").update(message).digest("hex");
}

function canonicalQuery(data = {}) {
  const params = new URLSearchParams();
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
      continue;
    }

    params.append(key, String(value));
  }

  return params.toString();
}

function encodeJwtHS256(secret, payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = hmacSha256(secret, `${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

class ExchangeHttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExchangeHttpError";
    this.status = details.status ?? null;
    this.payload = details.payload ?? null;
    this.retryable = Boolean(details.retryable);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asOrderRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.orders)) {
    return payload.orders;
  }
  if (Array.isArray(payload.result)) {
    return payload.result;
  }

  if (payload.uuid || payload.id || payload.order_id || payload.orderId) {
    return [payload];
  }

  return [];
}

function normalizeIdentifier(order = {}) {
  const candidates = [
    order.identifier,
    order.client_order_key,
    order.clientOrderKey,
    order.client_order_id,
    order.clientOrderId,
  ];

  for (const item of candidates) {
    if (item !== undefined && item !== null && String(item).trim() !== "") {
      return String(item).trim();
    }
  }
  return null;
}

function normalizeTs(order = {}) {
  const candidates = [order.created_at, order.createdAt, order.timestamp, order.updated_at, order.updatedAt];
  for (const item of candidates) {
    const ts = Date.parse(item || "");
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return 0;
}

function objectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

export class BithumbClient {
  constructor(config, logger, options = {}) {
    this.config = config;
    this.logger = logger;
    this.baseUrl = config.exchange.baseUrl;
    this.accessKey = config.exchange.accessKey;
    this.secretKey = config.exchange.secretKey;
    this.timeoutMs = config.exchange.timeoutMs;
    this.maxRetries = config.exchange.maxRetries;
    this.retryBaseMs = config.exchange.retryBaseMs;
    this.publicLimiter = new PerSecondSlidingWindowLimiter({
      maxPerSec: config.exchange.publicMaxPerSec,
    });
    this.privateLimiter = new PerSecondSlidingWindowLimiter({
      maxPerSec: config.exchange.privateMaxPerSec,
    });
    this.onRequestEvent = typeof options.onRequestEvent === "function" ? options.onRequestEvent : null;
    this.nowFn = typeof options.nowFn === "function" ? options.nowFn : () => Date.now();
  }

  ensureAuthConfigured() {
    if (!this.accessKey || !this.secretKey) {
      throw new ExchangeHttpError("Missing Bithumb API credentials", { retryable: false });
    }
  }

  authHeader(method, path, query = {}, body = {}) {
    const nonce = uuid();
    const timestamp = Date.now();
    const queryString = canonicalQuery(method === "GET" || method === "DELETE" ? query : body);

    const payload = {
      access_key: this.accessKey,
      nonce,
      timestamp,
    };

    if (queryString) {
      payload.query_hash = sha512Hex(queryString);
      payload.query_hash_alg = "SHA512";
    }

    const token = encodeJwtHS256(this.secretKey, payload);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  isRetryableError(error) {
    if (!error) {
      return false;
    }
    if (error.retryable) {
      return true;
    }
    if (error.status === 429) {
      return true;
    }
    return typeof error.status === "number" && error.status >= 500;
  }

  shouldUseFallbackEndpoint(error) {
    if (!error || !Number.isFinite(error.status)) {
      return false;
    }

    return new Set([400, 404, 405, 422]).has(error.status);
  }

  emitRequestEvent(event) {
    if (!this.onRequestEvent) {
      return;
    }
    try {
      this.onRequestEvent(event);
    } catch (error) {
      this.logger.warn("exchange request audit hook failed", {
        reason: error.message,
      });
    }
  }

  async request({
    method = "GET",
    path,
    query = {},
    body = null,
    requiresAuth = false,
    attempt = 1,
  }) {
    const methodUpper = method.toUpperCase();
    const queryString = canonicalQuery(query);
    const url = queryString ? `${this.baseUrl}${path}?${queryString}` : `${this.baseUrl}${path}`;
    const startedAt = this.nowFn();
    const headers = {
      Accept: "application/json",
    };

    if (requiresAuth) {
      this.ensureAuthConfigured();
      Object.assign(headers, this.authHeader(methodUpper, path, query, body || {}));
    }

    const limiter = requiresAuth ? this.privateLimiter : this.publicLimiter;
    await limiter.take(1);
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    let response;
    let payload;

    try {
      response = await fetch(url, {
        method: methodUpper,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutController.signal,
      });
      const text = await response.text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      } else {
        payload = null;
      }
    } catch (error) {
      clearTimeout(timeout);
      let wrappedError;
      if (error.name === "AbortError") {
        wrappedError = new ExchangeHttpError(`Request timeout: ${methodUpper} ${path}`, {
          retryable: true,
        });
      } else {
        wrappedError = new ExchangeHttpError(error.message, { retryable: true });
      }

      this.emitRequestEvent({
        ts: startedAt,
        method: methodUpper,
        path,
        requiresAuth,
        attempt,
        queryKeys: objectKeys(query),
        bodyKeys: objectKeys(body),
        ok: false,
        status: wrappedError.status ?? null,
        retryable: this.isRetryableError(wrappedError),
        error: wrappedError.message,
        durationMs: this.nowFn() - startedAt,
      });
      throw wrappedError;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const message = payload?.message || payload?.error?.message || `HTTP ${response.status}`;
      const error = new ExchangeHttpError(message, {
        status: response.status,
        payload,
        retryable: response.status === 429 || response.status >= 500,
      });
      this.emitRequestEvent({
        ts: startedAt,
        method: methodUpper,
        path,
        requiresAuth,
        attempt,
        queryKeys: objectKeys(query),
        bodyKeys: objectKeys(body),
        ok: false,
        status: response.status,
        retryable: this.isRetryableError(error),
        error: message,
        durationMs: this.nowFn() - startedAt,
      });
      throw error;
    }

    this.emitRequestEvent({
      ts: startedAt,
      method: methodUpper,
      path,
      requiresAuth,
      attempt,
      queryKeys: objectKeys(query),
      bodyKeys: objectKeys(body),
      ok: true,
      status: response.status,
      retryable: false,
      error: null,
      durationMs: this.nowFn() - startedAt,
    });
    return payload;
  }

  async withRetry(req) {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        return await this.request({
          ...req,
          attempt: attempt + 1,
        });
      } catch (error) {
        if (!this.isRetryableError(error) || attempt === this.maxRetries) {
          throw error;
        }

        const backoff = this.retryBaseMs * 2 ** attempt;
        const jitter = Math.round(Math.random() * 50);
        this.logger.warn("retrying exchange request", {
          attempt: attempt + 1,
          path: req.path,
          waitMs: backoff + jitter,
          reason: error.message,
        });
        await sleep(backoff + jitter);
        attempt += 1;
      }
    }

    throw new ExchangeHttpError("retry loop exhausted", { retryable: true });
  }

  async getAccounts() {
    return this.withRetry({
      method: "GET",
      path: "/v1/accounts",
      requiresAuth: true,
    });
  }

  async getOrderChance({ symbol }) {
    return this.withRetry({
      method: "GET",
      path: "/v1/orders/chance",
      query: {
        market: toBithumbMarket(symbol),
      },
      requiresAuth: true,
    });
  }

  async listOrders({
    symbol = null,
    uuids = null,
    state = null,
    states = null,
    page = 1,
    limit = 100,
    orderBy = "desc",
  } = {}) {
    const query = {
      market: symbol ? toBithumbMarket(symbol) : undefined,
      uuids: Array.isArray(uuids) && uuids.length > 0 ? uuids : undefined,
      state: state || undefined,
      states: Array.isArray(states) && states.length > 0 ? states : undefined,
      page,
      limit,
      order_by: orderBy,
    };

    const primary = () =>
      this.withRetry({
        method: "GET",
        path: "/v1/orders",
        query,
        requiresAuth: true,
      });

    const fallback = () =>
      this.withRetry({
        method: "GET",
        path: "/v2/orders",
        query,
        requiresAuth: true,
      });

    try {
      return await primary();
    } catch (error) {
      if (!this.shouldUseFallbackEndpoint(error)) {
        throw error;
      }
      return fallback();
    }
  }

  async getOrder({ exchangeOrderId, symbol = null }) {
    const queryV1 = {
      uuid: exchangeOrderId,
    };
    const queryV2 = {
      uuid: exchangeOrderId,
      market: symbol ? toBithumbMarket(symbol) : undefined,
    };

    const primary = () =>
      this.withRetry({
        method: "GET",
        path: "/v1/order",
        query: queryV1,
        requiresAuth: true,
      });

    const fallback = () =>
      this.withRetry({
        method: "GET",
        path: "/v2/order",
        query: queryV2,
        requiresAuth: true,
      });

    try {
      return await primary();
    } catch (error) {
      if (!this.shouldUseFallbackEndpoint(error)) {
        throw error;
      }
      return fallback();
    }
  }

  buildOrderStatusQueryCandidates({ exchangeOrderId, clientOrderKey, market }) {
    const candidates = [];
    if (exchangeOrderId && clientOrderKey) {
      candidates.push({
        uuid: exchangeOrderId,
        identifier: clientOrderKey,
        market,
      });
    }

    if (exchangeOrderId) {
      candidates.push({
        uuid: exchangeOrderId,
        market,
      });
      candidates.push({
        uuid: exchangeOrderId,
      });
    }

    if (clientOrderKey) {
      candidates.push({
        identifier: clientOrderKey,
        market,
      });
      candidates.push({
        identifier: clientOrderKey,
      });
    }

    const unique = [];
    const seen = new Set();
    for (const query of candidates) {
      const normalized = Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ""),
      );
      const key = canonicalQuery(normalized);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(normalized);
    }
    return unique;
  }

  async lookupOrderByPaths(query) {
    const paths = ["/v2/order", "/v1/order"];
    let lastError = null;

    for (const path of paths) {
      try {
        const payload = await this.withRetry({
          method: "GET",
          path,
          query,
          requiresAuth: true,
        });
        return {
          ...payload,
          _lookupSource: path,
        };
      } catch (error) {
        if (this.shouldUseFallbackEndpoint(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new ExchangeHttpError("Order lookup failed", { retryable: false });
  }

  findByFingerprint(rows, { symbol, orderHint = {} } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    const market = symbol ? toBithumbMarket(symbol) : null;
    const sideHint = orderHint?.side
      ? (String(orderHint.side).toLowerCase() === "sell" ? "ask" : "bid")
      : null;
    const typeHintRaw = String(orderHint?.type || "").toLowerCase();
    const typeHint = typeHintRaw === "market"
      ? (sideHint === "ask" ? "market" : "price")
      : typeHintRaw === "limit" || typeHintRaw === "price"
        ? typeHintRaw
        : null;
    const priceHint = asNumber(orderHint?.price);
    const qtyHint = asNumber(orderHint?.qty);
    const createdAtHint = Date.parse(orderHint?.createdAt || "");
    const maxAgeDiffMs = 10 * 60 * 1000;

    const matched = rows.filter((row) => {
      if (market && row.market && String(row.market) !== market) {
        return false;
      }

      if (sideHint && row.side && String(row.side).toLowerCase() !== sideHint) {
        return false;
      }

      if (typeHint && row.ord_type && String(row.ord_type).toLowerCase() !== typeHint) {
        return false;
      }

      const rowPrice = asNumber(row.price);
      if (priceHint !== null && rowPrice !== null && Math.abs(rowPrice - priceHint) > Math.max(0.00000001, priceHint * 0.000001)) {
        return false;
      }

      const rowVolume = asNumber(row.volume);
      if (qtyHint !== null && rowVolume !== null && Math.abs(rowVolume - qtyHint) > Math.max(0.00000001, qtyHint * 0.000001)) {
        return false;
      }

      if (Number.isFinite(createdAtHint)) {
        const rowTs = normalizeTs(row);
        if (rowTs > 0 && Math.abs(rowTs - createdAtHint) > maxAgeDiffMs) {
          return false;
        }
      }

      return true;
    });

    const deduped = [];
    const seen = new Set();
    for (const row of matched) {
      const key = String(row.uuid || row.order_id || row.orderId || normalizeTs(row));
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(row);
    }

    if (deduped.length !== 1) {
      return null;
    }
    return deduped[0];
  }

  async findOrderByClientOrderKey({ symbol, clientOrderKey, orderHint = null }) {
    if (!clientOrderKey) {
      return null;
    }

    const market = symbol ? toBithumbMarket(symbol) : undefined;
    const paths = [
      "/v1/orders",
      "/v2/orders",
      "/v1/orders/open",
      "/v2/orders/open",
      "/v1/orders/closed",
      "/v2/orders/closed",
    ];
    const queryCandidates = [
      {
        market,
        state: "wait",
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        state: "watch",
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        state: "done",
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        state: "cancel",
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        states: ["wait", "watch"],
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        states: ["done", "cancel"],
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
        page: 1,
        limit: 100,
        order_by: "desc",
      },
      {
        market,
      },
    ];
    const queries = [];
    const seenQueries = new Set();
    for (const candidate of queryCandidates) {
      const normalized = Object.fromEntries(
        Object.entries(candidate).filter(([, value]) => value !== undefined && value !== null && value !== ""),
      );
      const key = canonicalQuery(normalized);
      if (!key || seenQueries.has(key)) {
        continue;
      }
      seenQueries.add(key);
      queries.push(normalized);
    }

    const rowsCollected = [];
    for (const path of paths) {
      for (const query of queries) {
        try {
          const payload = await this.withRetry({
            method: "GET",
            path,
            query,
            requiresAuth: true,
          });
          const rows = asOrderRows(payload);
          rowsCollected.push(...rows);

          const exact = rows
            .filter((row) => normalizeIdentifier(row) === clientOrderKey)
            .sort((a, b) => normalizeTs(b) - normalizeTs(a))
            .at(0);
          if (exact) {
            return {
              ...exact,
              _lookupSource: `${path}:identifier`,
            };
          }
        } catch (error) {
          if (this.shouldUseFallbackEndpoint(error)) {
            continue;
          }
          throw error;
        }
      }
    }

    const fingerprint = this.findByFingerprint(rowsCollected, { symbol, orderHint });
    if (fingerprint) {
      return {
        ...fingerprint,
        _lookupSource: "orders:list:fingerprint",
      };
    }
    return null;
  }

  async getOrderStatus({ exchangeOrderId, symbol, clientOrderKey, orderHint = null }) {
    if (!exchangeOrderId && !clientOrderKey) {
      throw new ExchangeHttpError("Order lookup requires exchangeOrderId or clientOrderKey", { retryable: false });
    }

    if (!exchangeOrderId && clientOrderKey) {
      const fallback = await this.findOrderByClientOrderKey({
        symbol,
        clientOrderKey,
        orderHint,
      });
      if (fallback) {
        return fallback;
      }
      throw new ExchangeHttpError("Unable to resolve order status by clientOrderKey", {
        retryable: false,
        status: 404,
      });
    }

    const market = symbol ? toBithumbMarket(symbol) : undefined;
    const queries = this.buildOrderStatusQueryCandidates({
      exchangeOrderId,
      clientOrderKey,
      market,
    });

    let lastError = null;
    for (const query of queries) {
      try {
        return await this.lookupOrderByPaths(query);
      } catch (error) {
        if (this.shouldUseFallbackEndpoint(error)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    const fallback = await this.findOrderByClientOrderKey({
      symbol,
      clientOrderKey,
      orderHint,
    });
    if (fallback) {
      return fallback;
    }

    if (lastError) {
      throw lastError;
    }
    throw new ExchangeHttpError("Unable to resolve order status", { retryable: false });
  }

  async placeOrder({ symbol, side, type, price, qty, amountKrw = null, clientOrderKey = null }) {
    const market = toBithumbMarket(symbol);
    const sideNormalized = String(side || "").toLowerCase() === "sell" ? "ask" : "bid";
    const typeNormalized = String(type || "limit").toLowerCase();
    let ordType = typeNormalized;

    // Internal market type maps to Bithumb:
    // - side=buy  -> ord_type=price (market buy)
    // - side=sell -> ord_type=market (market sell)
    if (typeNormalized === "market" && sideNormalized === "bid") {
      ordType = "price";
    }

    const body = {
      market,
      side: sideNormalized,
      ord_type: ordType,
    };

    if (clientOrderKey) {
      body.identifier = String(clientOrderKey);
    }

    if (ordType === "limit") {
      body.price = String(price);
      body.volume = String(qty);
    } else if (ordType === "price") {
      if (sideNormalized !== "bid") {
        throw new ExchangeHttpError("ord_type=price requires side=bid", { retryable: false });
      }
      const spend = Number.isFinite(Number(amountKrw)) ? Number(amountKrw) : Number(price);
      if (!Number.isFinite(spend) || spend <= 0) {
        throw new ExchangeHttpError("Invalid market-buy notional (price)", { retryable: false });
      }
      body.price = String(spend);
    } else if (ordType === "market") {
      if (sideNormalized !== "ask") {
        throw new ExchangeHttpError("ord_type=market requires side=ask", { retryable: false });
      }
      body.volume = String(qty);
    } else {
      throw new ExchangeHttpError(`Unsupported order type: ${type}`, { retryable: false });
    }

    const primary = () =>
      this.withRetry({
        method: "POST",
        path: "/v1/orders",
        body,
        requiresAuth: true,
      });

    const fallback = () =>
      this.withRetry({
        method: "POST",
        path: "/v2/orders",
        body,
        requiresAuth: true,
      });

    try {
      return await primary();
    } catch (error) {
      if (!this.shouldUseFallbackEndpoint(error)) {
        throw error;
      }
      return fallback();
    }
  }

  async cancelOrder({ exchangeOrderId, symbol }) {
    const queryV1 = {
      uuid: exchangeOrderId,
    };
    const queryV2 = {
      uuid: exchangeOrderId,
      market: symbol ? toBithumbMarket(symbol) : undefined,
    };

    const primary = () =>
      this.withRetry({
        method: "DELETE",
        path: "/v1/order",
        query: queryV1,
        requiresAuth: true,
      });

    const fallback = () =>
      this.withRetry({
        method: "DELETE",
        path: "/v2/order",
        query: queryV2,
        requiresAuth: true,
      });

    try {
      return await primary();
    } catch (error) {
      if (!this.shouldUseFallbackEndpoint(error)) {
        throw error;
      }
      return fallback();
    }
  }
}
