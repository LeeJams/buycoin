import { codeName } from "../config/exit-codes.js";
import { normalizeErrorPayload } from "./errors.js";
import { maskSecrets } from "./mask.js";
import { nowIso } from "./time.js";

function write(level, message, context = {}) {
  const log = {
    timestamp: nowIso(),
    level,
    message,
    ...maskSecrets(context),
  };

  if (level === "error") {
    process.stderr.write(`${JSON.stringify(log)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(log)}\n`);
}

export const logger = {
  info(message, context) {
    write("info", message, context);
  },
  warn(message, context) {
    write("warn", message, context);
  },
  error(message, context) {
    write("error", message, context);
  },
};

export function printResult({ json, command, status, code = 0, data = null, error = null, correlationId = null }) {
  const normalizedError = status === "error" ? normalizeErrorPayload(error, code) : null;

  if (json) {
    const payload = {
      timestamp: nowIso(),
      command,
      status,
      code,
      code_name: codeName(code),
      correlation_id: correlationId,
      data: maskSecrets(data),
      error: maskSecrets(normalizedError),
    };

    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (status === "ok") {
    process.stdout.write(`[OK] ${command}\n`);
    if (data) {
      process.stdout.write(`${formatHumanData(data)}\n`);
    }
    return;
  }

  process.stdout.write(`[ERROR] ${command} (${codeName(code)})\n`);
  if (normalizedError) {
    process.stdout.write(`${formatHumanData(normalizedError)}\n`);
  }
}

function formatHumanData(data) {
  if (typeof data === "string") {
    return data;
  }

  return JSON.stringify(maskSecrets(data), null, 2);
}
