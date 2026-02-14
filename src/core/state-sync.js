import { EXIT_CODES } from "../config/exit-codes.js";
import { uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { normalizeAccounts } from "./account-normalizer.js";

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapExchangeState(status = {}, targetOrder = null) {
  const raw = String(status?.state ?? status?.status ?? "").toUpperCase();
  const executed = asNumber(status.executed_volume);
  const remaining = asNumber(status.remaining_volume);

  const baseMap = {
    WAIT: "ACCEPTED",
    WATCH: "ACCEPTED",
    NEW: "ACCEPTED",
    ACCEPTED: "ACCEPTED",
    PARTIAL: "PARTIAL",
    DONE: "FILLED",
    FILLED: "FILLED",
    CANCEL: "CANCELED",
    CANCELED: "CANCELED",
    CANCELLED: "CANCELED",
    REJECT: "REJECTED",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
  };

  if (raw in baseMap) {
    if (baseMap[raw] === "ACCEPTED" && executed !== null && executed > 0) {
      if (remaining !== null && remaining <= 0) {
        return "FILLED";
      }
      return "PARTIAL";
    }
    return baseMap[raw];
  }

  if (executed !== null && executed > 0) {
    if (remaining !== null && remaining <= 0) {
      return "FILLED";
    }
    return "PARTIAL";
  }

  if (targetOrder?.state === "UNKNOWN_SUBMIT") {
    return "ACCEPTED";
  }
  return raw || null;
}

function pickExchangeOrderId(status = {}) {
  const candidates = [status.uuid, status.order_id, status.orderId, status.id];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

export class StateSync {
  constructor(store, exchangeClient, logger) {
    this.store = store;
    this.exchangeClient = exchangeClient;
    this.logger = logger;
  }

  async reconcile() {
    const state = this.store.snapshot();
    const unknown = state.orders.filter((order) => order.state === "UNKNOWN_SUBMIT");
    const recoverableMissingExchangeId = state.orders.filter(
      (order) =>
        order.state !== "UNKNOWN_SUBMIT" &&
        !order.paper &&
        !order.exchangeOrderId &&
        ["NEW", "ACCEPTED", "PARTIAL", "CANCEL_REQUESTED"].includes(order.state),
    );
    const targets = [...unknown, ...recoverableMissingExchangeId];
    let mismatchCount = 0;
    let resolvedUnknownOrders = 0;
    let resolvedMissingExchangeIdOrders = 0;
    let fallbackLookups = 0;
    for (const order of targets) {
      try {
        if (!order.exchangeOrderId) {
          fallbackLookups += 1;
        }
        const status = await this.exchangeClient.getOrderStatus({
          exchangeOrderId: order.exchangeOrderId,
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

        const nextState = mapExchangeState(status, order);
        if (nextState) {
          const executed = asNumber(status.executed_volume);
          const remaining = asNumber(status.remaining_volume);
          const exchangeOrderId = pickExchangeOrderId(status);

          await this.store.update((s) => {
            const target = s.orders.find((item) => item.id === order.id);
            if (!target) {
              return s;
            }
            target.state = nextState;
            if (!target.exchangeOrderId && exchangeOrderId) {
              target.exchangeOrderId = exchangeOrderId;
            }
            if (executed !== null) {
              target.filledQty = executed;
            }
            if (remaining !== null) {
              target.remainingQty = Math.max(remaining, 0);
            } else if (executed !== null && Number.isFinite(target.qty)) {
              target.remainingQty = Math.max(Number(target.qty) - executed, 0);
            }
            target.updatedAt = nowIso();
            s.orderEvents.push({
              id: uuid(),
              orderId: target.id,
              eventType: "RECONCILED",
              payload: {
                previousState: order.state,
                nextState,
                source: status?._lookupSource || "order_lookup",
                exchangeOrderId: exchangeOrderId || target.exchangeOrderId || null,
              },
              eventTs: nowIso(),
            });
            return s;
          });
          if (order.state === "UNKNOWN_SUBMIT") {
            resolvedUnknownOrders += 1;
          } else {
            resolvedMissingExchangeIdOrders += 1;
          }
        } else {
          mismatchCount += 1;
        }
      } catch (error) {
        this.logger.warn("reconcile failed for order", {
          orderId: order.id,
          reason: error.message,
        });
        mismatchCount += 1;
      }
    }

    const accountSync = {
      attempted: false,
      ok: false,
      count: 0,
      error: null,
    };

    if (this.exchangeClient.accessKey && this.exchangeClient.secretKey) {
      accountSync.attempted = true;
      try {
        const payload = await this.exchangeClient.getAccounts();
        const accounts = normalizeAccounts(payload);
        const capturedAt = nowIso();

        await this.store.update((nextState) => {
          nextState.balancesSnapshot.push({
            id: uuid(),
            capturedAt,
            source: "reconcile",
            items: accounts,
          });
          if (nextState.balancesSnapshot.length > 200) {
            nextState.balancesSnapshot = nextState.balancesSnapshot.slice(-200);
          }
          return nextState;
        });

        accountSync.ok = true;
        accountSync.count = accounts.length;
      } catch (error) {
        this.logger.warn("reconcile account sync failed", {
          reason: error.message,
        });
        mismatchCount += 1;
        accountSync.error = error.message;
      }
    }

    const summary = {
      checkedAt: nowIso(),
      unknownOrders: unknown.length,
      recoverableMissingExchangeIdOrders: recoverableMissingExchangeId.length,
      resolvedUnknownOrders,
      resolvedMissingExchangeIdOrders,
      mismatches: mismatchCount,
      fallbackLookups,
      accountSync,
    };

    if (mismatchCount > 0) {
      return {
        ok: false,
        code: EXIT_CODES.RECONCILE_MISMATCH,
        error: {
          message: "Reconcile mismatch detected",
          type: "RECONCILE_MISMATCH",
          retryable: true,
          details: summary,
        },
      };
    }

    return {
      ok: true,
      code: EXIT_CODES.OK,
      data: summary,
    };
  }
}
