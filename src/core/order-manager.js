import { EXIT_CODES } from "../config/exit-codes.js";
import { clientOrderKey, uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

const END_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

function pickExchangeOrderId(payload = {}) {
  const candidates = [payload.uuid, payload.order_id, payload.orderId, payload.id];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

export class OrderManager {
  constructor(config, store, exchangeClient, logger) {
    this.config = config;
    this.store = store;
    this.exchangeClient = exchangeClient;
    this.logger = logger;
  }

  async placeOrder(orderInput, context = {}) {
    const {
      symbol,
      side,
      type = "limit",
      price,
      qty,
      amountKrw = null,
      strategyRunId = "manual",
      correlationId = uuid(),
    } = orderInput;

    const key = orderInput.clientOrderKey || clientOrderKey({ strategyRunId, symbol, side });

    const orderBase = {
      id: uuid(),
      clientOrderKey: key,
      exchangeOrderId: null,
      symbol,
      side,
      type,
      price: Number(price),
      amountKrw: amountKrw !== null && amountKrw !== undefined ? Number(amountKrw) : Number(price) * Number(qty),
      qty: Number(qty),
      remainingQty: Number(qty),
      filledQty: 0,
      avgFillPrice: null,
      strategyRunId,
      paper: Boolean(context.paperMode),
      state: "NEW",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      correlationId,
    };

    let duplicated = null;
    await this.store.update((state) => {
      duplicated = state.orders.find((order) => order.clientOrderKey === key) || null;
      if (duplicated) {
        return state;
      }

      state.orders.push(orderBase);
      state.orderEvents.push({
        id: uuid(),
        orderId: orderBase.id,
        eventType: "NEW",
        payload: { ...orderBase },
        eventTs: nowIso(),
      });
      return state;
    });

    if (duplicated) {
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: {
          ...duplicated,
          idempotentHit: true,
        },
      };
    }

    if (context.paperMode) {
      await this.transitionOrder(orderBase.id, "ACCEPTED", { source: "paper-simulator" });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: this.store.findOrderById(orderBase.id),
      };
    }

    try {
      const response = await this.exchangeClient.placeOrder({
        symbol,
        side,
        type,
        price,
        qty,
        amountKrw,
        clientOrderKey: key,
      });

      const exchangeOrderId = response?.orderId || response?.order_id || response?.uuid || response?.id || null;
      await this.store.update((state) => {
        const order = state.orders.find((o) => o.id === orderBase.id);
        if (!order) {
          return state;
        }
        order.exchangeOrderId = exchangeOrderId;
        order.state = "ACCEPTED";
        order.updatedAt = nowIso();
        state.orderEvents.push({
          id: uuid(),
          orderId: order.id,
          eventType: "ACCEPTED",
          payload: { exchangeOrderId, response },
          eventTs: nowIso(),
        });
        return state;
      });

      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: this.store.findOrderById(orderBase.id),
      };
    } catch (error) {
      await this.transitionOrder(orderBase.id, "UNKNOWN_SUBMIT", {
        reason: error.message,
      });

      const retryable = this.exchangeClient.isRetryableError(error);
      const code = error?.status === 429
        ? EXIT_CODES.RATE_LIMITED
        : retryable
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL;

      return {
        ok: false,
        code,
        error: {
          message: error.message,
          hint: "Order may have been submitted. Run reconcile.",
          orderId: orderBase.id,
          clientOrderKey: key,
          retryable,
        },
      };
    }
  }

  async cancelOrder(orderId, context = {}) {
    const order = this.store.findOrderById(orderId);
    if (!order) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: { message: `Order not found: ${orderId}` },
      };
    }

    if (END_STATES.has(order.state)) {
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: { orderId: order.id, state: order.state, message: "already terminal state" },
      };
    }

    if (context.paperMode || order.paper) {
      await this.transitionOrder(order.id, "CANCELED", { source: "paper-simulator" });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: this.store.findOrderById(order.id),
      };
    }

    let exchangeOrderId = order.exchangeOrderId;
    if (!exchangeOrderId && order.clientOrderKey) {
      try {
        const status = await this.exchangeClient.getOrderStatus({
          exchangeOrderId: null,
          symbol: order.symbol,
          clientOrderKey: order.clientOrderKey,
          orderHint: {
            side: order.side,
            type: order.type,
            price: order.price,
            qty: order.qty,
            createdAt: order.createdAt,
          },
        });
        exchangeOrderId = pickExchangeOrderId(status);
        if (exchangeOrderId) {
          await this.store.update((state) => {
            const target = state.orders.find((item) => item.id === order.id);
            if (!target) {
              return state;
            }
            if (!target.exchangeOrderId) {
              target.exchangeOrderId = exchangeOrderId;
              target.updatedAt = nowIso();
            }
            state.orderEvents.push({
              id: uuid(),
              orderId: target.id,
              eventType: "EXCHANGE_ID_RESOLVED",
              payload: {
                source: "cancel-fallback-lookup",
                exchangeOrderId,
              },
              eventTs: nowIso(),
            });
            return state;
          });
        }
      } catch (error) {
        return {
          ok: false,
          code: this.exchangeClient.isRetryableError(error)
            ? EXIT_CODES.EXCHANGE_RETRYABLE
            : EXIT_CODES.EXCHANGE_FATAL,
          error: { message: error.message },
        };
      }
    }

    if (!exchangeOrderId) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: { message: `Order has no exchange UUID: ${order.id}` },
      };
    }

    try {
      await this.exchangeClient.cancelOrder({
        exchangeOrderId,
        symbol: order.symbol,
      });
      await this.transitionOrder(order.id, "CANCELED", { source: "exchange" });
      return {
        ok: true,
        code: EXIT_CODES.OK,
        data: this.store.findOrderById(order.id),
      };
    } catch (error) {
      return {
        ok: false,
        code: this.exchangeClient.isRetryableError(error)
          ? EXIT_CODES.EXCHANGE_RETRYABLE
          : EXIT_CODES.EXCHANGE_FATAL,
        error: { message: error.message },
      };
    }
  }

  async transitionOrder(orderId, nextState, payload = {}) {
    await this.store.update((state) => {
      const order = state.orders.find((item) => item.id === orderId);
      if (!order) {
        return state;
      }

      order.state = nextState;
      order.updatedAt = nowIso();
      state.orderEvents.push({
        id: uuid(),
        orderId,
        eventType: nextState,
        payload,
        eventTs: nowIso(),
      });
      return state;
    });
  }

  async applyFill({ orderId, fillId, price, qty, fee = 0 }) {
    await this.store.update((state) => {
      const order = state.orders.find((item) => item.id === orderId);
      if (!order) {
        return state;
      }

      const existingFill = state.fills.find((item) => item.exchangeFillId === fillId);
      if (existingFill) {
        return state;
      }

      const fillQty = Number(qty);
      const fillPrice = Number(price);
      order.filledQty += fillQty;
      order.remainingQty = Math.max(0, order.qty - order.filledQty);
      order.avgFillPrice =
        order.avgFillPrice === null
          ? fillPrice
          : (order.avgFillPrice * (order.filledQty - fillQty) + fillPrice * fillQty) / order.filledQty;
      order.updatedAt = nowIso();
      order.state = order.remainingQty > 0 ? "PARTIAL" : "FILLED";

      state.fills.push({
        id: uuid(),
        orderId,
        exchangeFillId: fillId,
        price: fillPrice,
        qty: fillQty,
        fee: Number(fee),
        fillTs: nowIso(),
      });
      state.orderEvents.push({
        id: uuid(),
        orderId,
        eventType: "FILL",
        payload: { fillId, price: fillPrice, qty: fillQty, fee: Number(fee) },
        eventTs: nowIso(),
      });
      return state;
    });
  }
}
