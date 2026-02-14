import { EXIT_CODES } from "../config/exit-codes.js";

const DEFAULT_ERROR_META = Object.freeze({
  [EXIT_CODES.INVALID_ARGS]: { type: "INVALID_ARGUMENT", retryable: false },
  [EXIT_CODES.RISK_REJECTED]: { type: "RISK_REJECTED", retryable: false },
  [EXIT_CODES.EXCHANGE_RETRYABLE]: { type: "EXCHANGE_RETRYABLE", retryable: true },
  [EXIT_CODES.EXCHANGE_FATAL]: { type: "EXCHANGE_FATAL", retryable: false },
  [EXIT_CODES.RATE_LIMITED]: { type: "RATE_LIMITED", retryable: true },
  [EXIT_CODES.RECONCILE_MISMATCH]: { type: "RECONCILE_MISMATCH", retryable: true },
  [EXIT_CODES.KILL_SWITCH_ACTIVE]: { type: "KILL_SWITCH_ACTIVE", retryable: false },
  [EXIT_CODES.INTERNAL_ERROR]: { type: "INTERNAL_ERROR", retryable: false },
  [EXIT_CODES.FORBIDDEN_IN_AGENT_MODE]: { type: "FORBIDDEN_IN_AGENT_MODE", retryable: false },
});

export class CliError extends Error {
  constructor(message, { code = EXIT_CODES.INVALID_ARGS, type, retryable, details = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.type = type || DEFAULT_ERROR_META[code]?.type || "ERROR";
    this.retryable = typeof retryable === "boolean" ? retryable : DEFAULT_ERROR_META[code]?.retryable ?? false;
    this.details = details;
  }
}

export function invalidArg(message, details = null) {
  return new CliError(message, {
    code: EXIT_CODES.INVALID_ARGS,
    type: "INVALID_ARGUMENT",
    retryable: false,
    details,
  });
}

export function isCliError(error) {
  return error instanceof CliError;
}

export function normalizeErrorPayload(error, fallbackCode = EXIT_CODES.INTERNAL_ERROR) {
  const defaults = DEFAULT_ERROR_META[fallbackCode] || DEFAULT_ERROR_META[EXIT_CODES.INTERNAL_ERROR];
  if (!error) {
    return {
      message: "Unknown error",
      type: defaults.type,
      retryable: defaults.retryable,
      details: null,
    };
  }

  if (typeof error === "string") {
    return {
      message: error,
      type: defaults.type,
      retryable: defaults.retryable,
      details: null,
    };
  }

  const message = typeof error.message === "string" ? error.message : "Unknown error";
  const type = typeof error.type === "string" ? error.type : defaults.type;
  const retryable = typeof error.retryable === "boolean" ? error.retryable : defaults.retryable;

  let details = null;
  if ("details" in error) {
    details = error.details;
  } else {
    const candidate = { ...error };
    delete candidate.message;
    delete candidate.type;
    delete candidate.retryable;
    delete candidate.code;
    if (Object.keys(candidate).length > 0) {
      details = candidate;
    }
  }

  return {
    message,
    type,
    retryable,
    details,
  };
}
