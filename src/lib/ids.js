import crypto from "node:crypto";

export function uuid() {
  return crypto.randomUUID();
}

export function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

export function clientOrderKey({ strategyRunId, symbol, side, nowMs }) {
  const safeSymbol = String(symbol || "UNKNOWN").replace(/[^A-Z0-9_]/g, "");
  const safeSide = String(side || "NA").toUpperCase();
  const runId = String(strategyRunId || "manual").slice(0, 12);
  const epoch = nowMs || Date.now();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${runId}-${safeSymbol}-${safeSide}-${epoch}-${suffix}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
