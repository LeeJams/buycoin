import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../lib/time.js";

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreToMultiplier(score, min, max) {
  const normalized = clamp((score + 1) / 2, 0, 1);
  return min + (max - min) * normalized;
}

export class OverlayEngine {
  constructor(config) {
    this.config = config;
    this.filePath = config.runtime.overlayFile;
  }

  async ensureDir() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async readRaw() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  normalize(input) {
    const min = this.config.overlay.minMultiplier;
    const max = this.config.overlay.maxMultiplier;
    const defaultMultiplier = this.config.overlay.defaultMultiplier;

    if (!input || typeof input !== "object") {
      return {
        multiplier: defaultMultiplier,
        source: "overlay_default",
        stale: false,
        updatedAt: null,
        score: null,
        regime: null,
      };
    }

    const updatedAt = input.updatedAt || null;
    const updatedTs = Date.parse(updatedAt || "");
    const ageSec = Number.isFinite(updatedTs) ? Math.max(0, (Date.now() - updatedTs) / 1000) : Infinity;
    const stale = ageSec > this.config.overlay.maxStalenessSec;

    const explicitMultiplier = asNumber(input.multiplier);
    const score = asNumber(input.score);

    let multiplier = defaultMultiplier;
    let source = "overlay_default";
    if (explicitMultiplier !== null && explicitMultiplier > 0) {
      multiplier = explicitMultiplier;
      source = "overlay_multiplier";
    } else if (score !== null) {
      multiplier = scoreToMultiplier(score, min, max);
      source = "overlay_score";
    }

    multiplier = clamp(multiplier, min, max);

    if (stale) {
      return {
        multiplier: this.config.overlay.fallbackMultiplier,
        source: "overlay_stale_fallback",
        stale: true,
        updatedAt,
        score,
        regime: input.regime || null,
      };
    }

    return {
      multiplier,
      source,
      stale: false,
      updatedAt,
      score,
      regime: input.regime || null,
    };
  }

  async readCurrent() {
    if (!this.config.overlay.enabled) {
      return {
        multiplier: 1,
        source: "overlay_disabled",
        stale: false,
        updatedAt: null,
        score: null,
        regime: null,
      };
    }

    const raw = await this.readRaw();
    return this.normalize(raw);
  }

  async setCurrent({ multiplier, score = null, regime = null, note = null } = {}) {
    await this.ensureDir();
    const min = this.config.overlay.minMultiplier;
    const max = this.config.overlay.maxMultiplier;
    const parsedMultiplier = asNumber(multiplier);
    const parsedScore = asNumber(score);

    const payload = {
      updatedAt: nowIso(),
      multiplier: parsedMultiplier === null ? null : clamp(parsedMultiplier, min, max),
      score: parsedScore,
      regime: regime || null,
      note: note || null,
    };

    await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    return this.normalize(payload);
  }
}
