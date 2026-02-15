import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./time.js";

export class HttpAuditLog {
  constructor(filePath, logger, { enabled = true } = {}) {
    this.filePath = filePath;
    this.logger = logger || {
      warn() {},
    };
    this.enabled = Boolean(enabled && filePath);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  write(event = {}) {
    if (!this.enabled) {
      return;
    }

    const row = {
      at: nowIso(),
      ...event,
    };

    const line = `${JSON.stringify(row)}\n`;
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.filePath, line, "utf8"))
      .catch((error) => {
        this.logger.warn("http audit log write failed", {
          reason: error.message,
        });
      });
  }

  async flush() {
    await this.writeQueue;
  }
}
