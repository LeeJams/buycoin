import { uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrderState(response = null) {
  const candidates = [
    response?.state,
    response?.status,
    response?.order_state,
    response?.orderState,
    response?.orderStatus,
    response?.order_status,
    response?.result?.state,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    const token = String(candidate).trim().toLowerCase();
    if (!token) {
      continue;
    }

    if (["wait", "watch", "done", "cancel", "canceled", "cancelled", "accepted", "accept", "new", "partial", "partial_fill", "partially_filled", "cancel_request", "cancel_requested", "accepted_wait"].includes(token)) {
      switch (token) {
        case "wait":
          return "WAIT";
        case "watch":
          return "WATCH";
        case "accepted":
        case "accept":
        case "accepted_wait":
          return "ACCEPTED";
        case "cancel_request":
        case "cancel_requested":
          return "CANCEL_REQUESTED";
        case "done":
          return "DONE";
        case "cancel":
        case "canceled":
        case "cancelled":
          return "CANCELED";
        default:
          return token.toUpperCase();
      }
    }
  }

  return "UNKNOWN_SUBMIT";
}

function resolveExchangeOrderId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidates = [payload.uuid, payload.order_id, payload.orderId, payload.id];
  for (const item of candidates) {
    if (item !== undefined && item !== null && String(item).trim() !== "") {
      return String(item).trim();
    }
  }
  return null;
}

export class ExecutionEngine {
  constructor(exchangeClient) {
    this.exchangeClient = exchangeClient;
  }

  async submit(orderInput) {
    const response = await this.exchangeClient.placeOrder({
      symbol: orderInput.symbol,
      side: orderInput.side,
      type: orderInput.type,
      price: orderInput.price,
      qty: orderInput.qty,
      amountKrw: orderInput.amountKrw,
      clientOrderKey: orderInput.clientOrderKey,
    });

    return {
      id: uuid(),
      exchangeOrderId: resolveExchangeOrderId(response),
      state: normalizeOrderState(response),
      placedAt: nowIso(),
      side: orderInput.side,
      type: orderInput.type,
      symbol: orderInput.symbol,
      amountKrw: orderInput.amountKrw,
      price: asNumber(orderInput.price),
      qty: asNumber(orderInput.qty),
      clientOrderKey: orderInput.clientOrderKey,
      raw: response,
    };
  }
}
