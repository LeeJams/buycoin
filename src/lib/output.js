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
