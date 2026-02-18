import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./time.js";

export class HttpAuditLog {
  constructor(
    filePath,
    logger,
    { enabled = true, maxBytes = 0, pruneRatio = 0.7, checkEvery = 200 } = {},
  ) {
    this.filePath = filePath;
    this.logger = logger || {
      info() {},
      warn() {},
    };
    this.enabled = Boolean(enabled && filePath);
    this.maxBytes = Number.isFinite(Number(maxBytes)) ? Math.max(0, Math.floor(Number(maxBytes))) : 0;
    this.pruneRatio = Number.isFinite(Number(pruneRatio)) ? Number(pruneRatio) : 0.7;
    this.checkEvery = Number.isFinite(Number(checkEvery)) ? Math.max(1, Math.floor(Number(checkEvery))) : 200;
    this.writeCount = 0;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) {
      return;
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.maxBytes > 0) {
      await this.enforceMaxBytes();
    }
  }

  async enforceMaxBytes() {
    if (this.maxBytes <= 0 || !this.filePath) {
      return;
    }

    const pruneRatio = this.pruneRatio > 0 && this.pruneRatio < 1 ? this.pruneRatio : 0.7;
    const targetBytes = Math.max(1024, Math.floor(this.maxBytes * pruneRatio));
    const stats = await fs.stat(this.filePath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (!stats || stats.size <= this.maxBytes) {
      return;
    }

    const raw = await fs.readFile(this.filePath).catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!raw || raw.length <= targetBytes) {
      return;
    }

    let tail = raw.subarray(raw.length - targetBytes);
    const firstNewLine = tail.indexOf(0x0a);
    if (firstNewLine >= 0 && firstNewLine + 1 < tail.length) {
      tail = tail.subarray(firstNewLine + 1);
    }

    await fs.writeFile(this.filePath, tail);
    this.logger.warn("http audit log rotated", {
      file: this.filePath,
      beforeBytes: stats.size,
      afterBytes: tail.length,
      maxBytes: this.maxBytes,
    });
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
    this.writeCount += 1;
    const shouldCheckLimit = this.maxBytes > 0 && this.writeCount % this.checkEvery === 0;
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.filePath, line, "utf8"))
      .then(() => (shouldCheckLimit ? this.enforceMaxBytes() : null))
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
