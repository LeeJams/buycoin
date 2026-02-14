export const EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID_ARGS: 2,
  RISK_REJECTED: 3,
  EXCHANGE_RETRYABLE: 5,
  EXCHANGE_FATAL: 6,
  RATE_LIMITED: 7,
  RECONCILE_MISMATCH: 8,
  KILL_SWITCH_ACTIVE: 9,
  INTERNAL_ERROR: 10,
  FORBIDDEN_IN_AGENT_MODE: 11,
});

export function codeName(value) {
  for (const [key, code] of Object.entries(EXIT_CODES)) {
    if (code === value) {
      return key;
    }
  }

  return "UNKNOWN";
}
