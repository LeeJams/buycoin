import { EXIT_CODES } from "../config/exit-codes.js";

export class AppError extends Error {
  constructor(message, { code = EXIT_CODES.INTERNAL_ERROR, type = "ERROR", retryable = false, details = null } = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.type = type;
    this.retryable = retryable;
    this.details = details;
  }
}

export function invalidArg(message, details = null) {
  return new AppError(message, {
    code: EXIT_CODES.INVALID_ARGS,
    type: "INVALID_ARGUMENT",
    retryable: false,
    details,
  });
}
