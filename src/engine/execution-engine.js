import { uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
      state: "ACCEPTED",
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
