import crypto from "node:crypto";
import { fromBithumbMarket, normalizeSymbol, toBithumbMarket } from "../config/defaults.js";
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

function encodeJwtHS256(secret, payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = hmacSha256(secret, `${encodedHeader}.${encodedPayload}`);
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeType(frame) {
  return String(frame?.type || frame?.ty || "").trim().toLowerCase();
}

function normalizeMarket(frame) {
  return String(frame?.code || frame?.cd || "").trim().toUpperCase();
}

function normalizeStreamType(frame) {
  return String(frame?.stream_type || frame?.st || "UNKNOWN").trim().toUpperCase();
}

function normalizeTimestamp(frame, fallbackCandidates = []) {
  const candidates = [frame?.timestamp, frame?.tms, ...fallbackCandidates];
  for (const value of candidates) {
    const ts = asNumber(value);
    if (ts !== null) {
      return ts;
    }
  }
  return Date.now();
}

async function toText(input) {
  if (typeof input === "string") {
    return input;
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return input.text();
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input).toString("utf8");
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return input.toString("utf8");
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input).toString("utf8");
  }
  if (input && typeof input === "object" && "toString" in input) {
    return String(input);
  }
  return "";
}

function bindHandler(ws, eventName, handler) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(eventName, handler);
    return;
  }
  if (typeof ws.on === "function") {
    ws.on(eventName, handler);
    return;
  }
  throw new Error("Unsupported WebSocket implementation: missing addEventListener/on");
}

function isSocketAlreadyOpen(ws) {
  const openState = typeof ws?.OPEN === "number" ? ws.OPEN : 1;
  return ws?.readyState === openState || ws?.readyState === 1;
}

function resolveWebSocketCtor(explicitCtor = null) {
  if (explicitCtor) {
    return explicitCtor;
  }
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket;
  }
  throw new Error("WebSocket is not available in current Node runtime");
}

function normalizeCodes(symbols = []) {
  return symbols
    .map((symbol) => normalizeSymbol(symbol))
    .filter(Boolean)
    .map((symbol) => toBithumbMarket(symbol));
}

function toWsError(parsed) {
  const name = String(parsed?.error?.name || "").trim();
  const message = String(parsed?.error?.message || "").trim();
  if (!name && !message) {
    return null;
  }
  return {
    name: name || "WS_ERROR",
    message: message || "WebSocket error response",
    payload: parsed,
  };
}

function toWsStatusError(parsed) {
  const status = String(parsed?.status || "").trim();
  if (!status || status === "0000") {
    return null;
  }
  const message = String(parsed?.resmsg || parsed?.message || "").trim();
  return {
    name: "WS_STATUS_ERROR",
    message: message || `WebSocket status error: ${status}`,
    status,
    payload: parsed,
  };
}

function parseOrderbookUnits(units) {
  if (!Array.isArray(units)) {
    return [];
  }
  return units
    .map((unit) => ({
      askPrice: asNumber(unit?.ask_price ?? unit?.ap),
      bidPrice: asNumber(unit?.bid_price ?? unit?.bp),
      askSize: asNumber(unit?.ask_size ?? unit?.as),
      bidSize: asNumber(unit?.bid_size ?? unit?.bs),
      raw: unit,
    }))
    .filter((unit) =>
      unit.askPrice !== null ||
      unit.bidPrice !== null ||
      unit.askSize !== null ||
      unit.bidSize !== null);
}

function parseAssetsRows(assets) {
  if (!Array.isArray(assets)) {
    return [];
  }
  return assets
    .map((asset) => ({
      currency: String(asset?.currency || asset?.cu || "").trim().toUpperCase(),
      balance: asNumber(asset?.balance ?? asset?.b),
      locked: asNumber(asset?.locked ?? asset?.l),
      raw: asset,
    }))
    .filter((asset) => asset.currency);
}

export function parseTickerFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  if (normalizeType(frame) !== "ticker") {
    return null;
  }

  const market = normalizeMarket(frame);
  if (!market) {
    return null;
  }

  const tradePrice = asNumber(frame.trade_price ?? frame.tp);
  if (tradePrice === null) {
    return null;
  }

  return {
    type: "ticker",
    market,
    symbol: fromBithumbMarket(market),
    tradePrice,
    streamType: normalizeStreamType(frame),
    timestamp: normalizeTimestamp(frame, [frame.trade_timestamp, frame.ttms]),
    raw: frame,
  };
}

export function parseTradeFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  if (normalizeType(frame) !== "trade") {
    return null;
  }

  const market = normalizeMarket(frame);
  if (!market) {
    return null;
  }

  const tradePrice = asNumber(frame.trade_price ?? frame.tp);
  const tradeVolume = asNumber(frame.trade_volume ?? frame.tv);
  if (tradePrice === null || tradeVolume === null) {
    return null;
  }

  return {
    type: "trade",
    market,
    symbol: fromBithumbMarket(market),
    tradePrice,
    tradeVolume,
    askBid: String(frame.ask_bid ?? frame.ab ?? "").toUpperCase() || null,
    sequentialId: asNumber(frame.sequential_id ?? frame.sid),
    streamType: normalizeStreamType(frame),
    timestamp: normalizeTimestamp(frame, [frame.trade_timestamp, frame.ttms]),
    raw: frame,
  };
}

export function parseOrderbookFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  if (normalizeType(frame) !== "orderbook") {
    return null;
  }

  const market = normalizeMarket(frame);
  if (!market) {
    return null;
  }

  return {
    type: "orderbook",
    market,
    symbol: fromBithumbMarket(market),
    totalAskSize: asNumber(frame.total_ask_size ?? frame.tas),
    totalBidSize: asNumber(frame.total_bid_size ?? frame.tbs),
    units: parseOrderbookUnits(frame.orderbook_units ?? frame.obu),
    level: asNumber(frame.level ?? frame.lv),
    streamType: normalizeStreamType(frame),
    timestamp: normalizeTimestamp(frame),
    raw: frame,
  };
}

export function parseMyOrderFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  if (normalizeType(frame) !== "myorder") {
    return null;
  }

  const market = normalizeMarket(frame);
  return {
    type: "myOrder",
    market: market || null,
    symbol: market ? fromBithumbMarket(market) : null,
    uuid: String(frame.uuid ?? frame.uid ?? "").trim() || null,
    askBid: String(frame.ask_bid ?? frame.ab ?? "").toUpperCase() || null,
    orderType: String(frame.order_type ?? frame.ot ?? "").toLowerCase() || null,
    state: String(frame.state ?? frame.s ?? "").toLowerCase() || null,
    tradeUuid: String(frame.trade_uuid ?? frame.tuid ?? "").trim() || null,
    price: asNumber(frame.price ?? frame.p),
    volume: asNumber(frame.volume ?? frame.v),
    remainingVolume: asNumber(frame.remaining_volume ?? frame.rv),
    executedVolume: asNumber(frame.executed_volume ?? frame.ev),
    tradesCount: asNumber(frame.trades_count ?? frame.tc),
    executedFunds: asNumber(frame.executed_funds ?? frame.ef),
    reservedFee: asNumber(frame.reserved_fee ?? frame.rsf),
    remainingFee: asNumber(frame.remaining_fee ?? frame.rmf),
    paidFee: asNumber(frame.paid_fee ?? frame.pf),
    orderTimestamp: asNumber(frame.order_timestamp ?? frame.otms),
    tradeTimestamp: asNumber(frame.trade_timestamp ?? frame.ttms),
    streamType: normalizeStreamType(frame),
    timestamp: normalizeTimestamp(frame),
    raw: frame,
  };
}

export function parseMyAssetFrame(frame) {
  if (!frame || typeof frame !== "object") {
    return null;
  }

  if (normalizeType(frame) !== "myasset") {
    return null;
  }

  return {
    type: "myAsset",
    assets: parseAssetsRows(frame.assets ?? frame.ast),
    assetTimestamp: asNumber(frame.asset_timestamp ?? frame.asttms),
    streamType: normalizeStreamType(frame),
    timestamp: normalizeTimestamp(frame),
    raw: frame,
  };
}

export class BithumbPublicWsClient {
  constructor(config, logger = null, options = {}) {
    this.config = config;
    this.logger = logger || {
      info() {},
      warn() {},
      error() {},
    };
    this.publicUrl = config.exchange.wsPublicUrl;
    this.privateUrl = config.exchange.wsPrivateUrl;
    this.accessKey = config.exchange.accessKey;
    this.secretKey = config.exchange.secretKey;
    this.WebSocketCtor = resolveWebSocketCtor(options.WebSocketCtor || null);
    this.privateWebSocketCtor = options.PrivateWebSocketCtor || null;
    this.connectLimiter = new PerSecondSlidingWindowLimiter({
      maxPerSec: config.exchange.wsConnectMaxPerSec,
      nowFn: options.nowFn,
      sleepFn: options.sleepFn,
    });
  }

  ensurePrivateAuthConfigured() {
    if (!this.accessKey || !this.secretKey) {
      throw new Error("Missing Bithumb API credentials for private WebSocket stream");
    }
  }

  buildPrivateAuthHeaders() {
    this.ensurePrivateAuthConfigured();
    const token = encodeJwtHS256(this.secretKey, {
      access_key: this.accessKey,
      nonce: uuid(),
      timestamp: Date.now(),
    });
    return {
      authorization: `Bearer ${token}`,
    };
  }

  async resolvePrivateSocketCtor() {
    if (this.privateWebSocketCtor) {
      return this.privateWebSocketCtor;
    }

    try {
      const wsModule = await import("ws");
      const ctor = wsModule?.WebSocket || wsModule?.default || null;
      if (typeof ctor === "function") {
        return ctor;
      }
    } catch {
      // no-op. fallback to current ctor below.
    }
    return this.WebSocketCtor;
  }

  async createSocket(url, { requiresAuth = false } = {}) {
    await this.connectLimiter.take(1);

    if (!requiresAuth) {
      return new this.WebSocketCtor(url);
    }

    const headers = this.buildPrivateAuthHeaders();
    const ctor = await this.resolvePrivateSocketCtor();

    try {
      return new ctor(url, { headers });
    } catch (error) {
      throw new Error(
        `Private WebSocket connect failed (header auth unsupported): ${error.message}`,
        { cause: error },
      );
    }
  }

  async openStream({
    url,
    requiresAuth = false,
    type,
    symbols = [],
    codesMode = "required",
    level = null,
    onData = () => {},
    onStatus = () => {},
    onError = () => {},
    parseFrame = null,
    isOnlyRealtime = true,
    isOnlySnapshot = false,
    includeRealtimeFlags = true,
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    const dataType = String(type || "").trim();
    if (!dataType) {
      throw new Error("WebSocket stream requires type");
    }

    const parsedCodes = normalizeCodes(Array.isArray(symbols) ? symbols : []);
    if (codesMode === "required" && parsedCodes.length === 0) {
      throw new Error(`${dataType} stream requires at least one symbol`);
    }

    const ws = await this.createSocket(url, { requiresAuth });
    let closed = false;
    let opened = false;
    let resolvedClosed = false;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const finalizeClosed = (payload) => {
      if (resolvedClosed) {
        return;
      }
      resolvedClosed = true;
      resolveClosed(payload);
    };

    const closeSafely = () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        if (typeof ws.close === "function") {
          ws.close();
        }
      } catch (error) {
        this.logger.warn("websocket close failed", {
          reason: error.message,
        });
      } finally {
        // Some runtimes may not emit close when socket closes during CONNECTING.
        setTimeout(() => {
          finalizeClosed({ code: null, reason: "forced_close_timeout" });
        }, 1000);
      }
    };

    const onOpen = () => {
      if (opened) {
        return;
      }
      opened = true;

      const typeField = { type: dataType };
      if (codesMode !== "none" && parsedCodes.length > 0) {
        typeField.codes = parsedCodes;
      }
      if (includeRealtimeFlags) {
        typeField.isOnlyRealtime = Boolean(isOnlyRealtime);
        typeField.isOnlySnapshot = Boolean(isOnlySnapshot);
      }
      if (level !== null && level !== undefined && level !== "") {
        typeField.level = Number(level);
      }

      const payload = [{ ticket: ticket || `trader-${uuid()}` }, typeField];
      if (String(format || "DEFAULT").toUpperCase() === "SIMPLE") {
        payload.push({ format: "SIMPLE" });
      }

      ws.send(JSON.stringify(payload));
      onStatus({
        event: "open",
        type: dataType,
        marketCodes: parsedCodes,
      });
    };

    const onMessage = async (eventOrData) => {
      try {
        const rawData = eventOrData?.data ?? eventOrData;
        const text = await toText(rawData);
        if (!text) {
          return;
        }

        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return;
        }

        const wsError = toWsError(parsed);
        if (wsError) {
          onStatus({
            event: "error",
            payload: parsed,
          });
          const error = new Error(`[${wsError.name}] ${wsError.message}`);
          error.name = wsError.name;
          error.payload = wsError.payload;
          onError(error);
          return;
        }

        const wsStatusError = toWsStatusError(parsed);
        if (wsStatusError) {
          onStatus({
            event: "status",
            payload: parsed,
          });
          const error = new Error(`[${wsStatusError.name}] ${wsStatusError.message}`);
          error.name = wsStatusError.name;
          error.status = wsStatusError.status;
          error.payload = wsStatusError.payload;
          onError(error);
          return;
        }

        const row = typeof parseFrame === "function" ? parseFrame(parsed) : parsed;
        if (row) {
          onData(row);
          return;
        }

        if (parsed.status) {
          onStatus({
            event: "status",
            payload: parsed,
          });
        }
      } catch (error) {
        onError(error);
      }
    };

    const onWsError = (eventOrError) => {
      const error = eventOrError instanceof Error
        ? eventOrError
        : new Error(eventOrError?.message || "WebSocket error");
      onError(error);
    };

    const onClose = (eventOrCode, maybeReason) => {
      if (!closed) {
        closed = true;
      }
      const closeCode = eventOrCode?.code ?? eventOrCode ?? null;
      const closeReason = eventOrCode?.reason ?? maybeReason ?? null;
      onStatus({
        event: "close",
        type: dataType,
        code: closeCode,
        reason: closeReason,
      });
      finalizeClosed({ code: closeCode, reason: closeReason });
    };

    bindHandler(ws, "open", onOpen);
    bindHandler(ws, "message", onMessage);
    bindHandler(ws, "error", onWsError);
    bindHandler(ws, "close", onClose);
    if (isSocketAlreadyOpen(ws)) {
      queueMicrotask(onOpen);
    }

    return {
      close: closeSafely,
      closed: closedPromise,
    };
  }

  async openTickerStream({
    symbols,
    onTicker = () => {},
    onStatus = () => {},
    onError = () => {},
    isOnlyRealtime = true,
    isOnlySnapshot = false,
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    return this.openStream({
      url: this.publicUrl,
      type: "ticker",
      symbols,
      codesMode: "required",
      onData: onTicker,
      onStatus,
      onError,
      parseFrame: parseTickerFrame,
      isOnlyRealtime,
      isOnlySnapshot,
      includeRealtimeFlags: true,
      format,
      ticket,
    });
  }

  async openTradeStream({
    symbols,
    onTrade = () => {},
    onStatus = () => {},
    onError = () => {},
    isOnlyRealtime = true,
    isOnlySnapshot = false,
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    return this.openStream({
      url: this.publicUrl,
      type: "trade",
      symbols,
      codesMode: "required",
      onData: onTrade,
      onStatus,
      onError,
      parseFrame: parseTradeFrame,
      isOnlyRealtime,
      isOnlySnapshot,
      includeRealtimeFlags: true,
      format,
      ticket,
    });
  }

  async openOrderbookStream({
    symbols,
    level = null,
    onOrderbook = () => {},
    onStatus = () => {},
    onError = () => {},
    isOnlyRealtime = true,
    isOnlySnapshot = false,
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    return this.openStream({
      url: this.publicUrl,
      type: "orderbook",
      symbols,
      codesMode: "required",
      level,
      onData: onOrderbook,
      onStatus,
      onError,
      parseFrame: parseOrderbookFrame,
      isOnlyRealtime,
      isOnlySnapshot,
      includeRealtimeFlags: true,
      format,
      ticket,
    });
  }

  async openMyOrderStream({
    symbols = null,
    onMyOrder = () => {},
    onStatus = () => {},
    onError = () => {},
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    return this.openStream({
      url: this.privateUrl,
      requiresAuth: true,
      type: "myOrder",
      symbols: symbols || [],
      codesMode: symbols ? "optional" : "none",
      onData: onMyOrder,
      onStatus,
      onError,
      parseFrame: parseMyOrderFrame,
      includeRealtimeFlags: false,
      format,
      ticket,
    });
  }

  async openMyAssetStream({
    onMyAsset = () => {},
    onStatus = () => {},
    onError = () => {},
    format = "DEFAULT",
    ticket = null,
  } = {}) {
    return this.openStream({
      url: this.privateUrl,
      requiresAuth: true,
      type: "myAsset",
      symbols: [],
      codesMode: "none",
      onData: onMyAsset,
      onStatus,
      onError,
      parseFrame: parseMyAssetFrame,
      includeRealtimeFlags: false,
      format,
      ticket,
    });
  }
}
