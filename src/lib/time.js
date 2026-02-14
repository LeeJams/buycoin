export function nowIso() {
  return new Date().toISOString();
}

export function nowMs() {
  return Date.now();
}

export function secondsFromNow(seconds) {
  return nowMs() + seconds * 1_000;
}

export function isExpired(epochMs, now = nowMs()) {
  return now >= epochMs;
}
