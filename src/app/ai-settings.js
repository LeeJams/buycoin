import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSymbol } from "../config/defaults.js";
import { nowIso } from "../lib/time.js";

const ALLOWED_STRATEGY_NAMES = new Set(["risk_managed_momentum", "breakout"]);
const ALLOWED_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "60m",
  "240m",
  "day",
  "week",
  "month",
]);
const ALLOWED_DECISION_MODES = new Set(["rule", "filter", "override"]);

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const token = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(token)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(token)) {
    return false;
  }
  return fallback;
}

function toPositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toPositiveInt(value, fallback) {
  const parsed = toPositiveNumber(value, fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}

function toNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullablePositiveNumber(value) {
  const parsed = toNullableNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
}

function normalizeStrategyName(value, fallback) {
  const token = String(value || fallback || "risk_managed_momentum")
    .trim()
    .toLowerCase();
  return ALLOWED_STRATEGY_NAMES.has(token) ? token : fallback;
}

function normalizeInterval(value, fallback) {
  const token = String(value || fallback || "15m").trim().toLowerCase();
  return ALLOWED_INTERVALS.has(token) ? token : fallback;
}

function toSymbolArray(value, fallback = []) {
  const base = Array.isArray(fallback) ? fallback : [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : base;

  const normalized = raw
    .map((item) => normalizeSymbol(String(item || "").trim()))
    .filter(Boolean);

  const unique = Array.from(new Set(normalized));
  if (unique.length > 0) {
    return unique;
  }
  return base.length > 0 ? Array.from(new Set(base.map((item) => normalizeSymbol(item)).filter(Boolean))) : [];
}

function normalizeOverlay(overlayRaw) {
  if (!overlayRaw || typeof overlayRaw !== "object") {
    return null;
  }

  const multiplier = toNullablePositiveNumber(overlayRaw.multiplier);
  const score = toNullableNumber(overlayRaw.score);
  const regime = overlayRaw.regime ? String(overlayRaw.regime) : null;
  const note = overlayRaw.note ? String(overlayRaw.note) : null;

  if (multiplier === null && score === null) {
    return null;
  }

  return {
    multiplier,
    score,
    regime,
    note,
  };
}

function normalizeDecisionMode(value, fallback = "filter") {
  const token = String(value || fallback || "filter")
    .trim()
    .toLowerCase();
  return ALLOWED_DECISION_MODES.has(token) ? token : fallback;
}

function normalizeDecisionAction(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (["buy", "bid"].includes(token)) {
    return "BUY";
  }
  if (["sell", "ask"].includes(token)) {
    return "SELL";
  }
  return null;
}

function normalizeDecisionBase(raw = {}, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  return {
    mode: normalizeDecisionMode(source.mode, normalizeDecisionMode(base.mode, "filter")),
    allowBuy: toBoolean(source.allowBuy, toBoolean(base.allowBuy, true)),
    allowSell: toBoolean(source.allowSell, toBoolean(base.allowSell, true)),
    forceAction: normalizeDecisionAction(
      source.forceAction ?? source.action ?? base.forceAction ?? null,
    ),
    forceAmountKrw: toNullablePositiveNumber(
      source.forceAmountKrw ?? source.amountKrw ?? base.forceAmountKrw ?? null,
    ),
    forceOnce: toBoolean(source.forceOnce, toBoolean(base.forceOnce, true)),
    note: source.note ? String(source.note) : (base.note ? String(base.note) : null),
  };
}

function normalizeDecision(raw = {}, fallback = {}) {
  const defaults = normalizeDecisionBase(fallback, {
    mode: "filter",
    allowBuy: true,
    allowSell: true,
    forceAction: null,
    forceAmountKrw: null,
    forceOnce: true,
    note: null,
  });

  const top = normalizeDecisionBase(raw, defaults);
  const decision = {
    ...top,
    symbols: {},
  };

  const symbolsRaw = raw?.symbols;
  if (!symbolsRaw || typeof symbolsRaw !== "object" || Array.isArray(symbolsRaw)) {
    return decision;
  }

  for (const [symbolRaw, row] of Object.entries(symbolsRaw)) {
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) {
      continue;
    }
    decision.symbols[symbol] = normalizeDecisionBase(row, top);
  }
  return decision;
}

export class AiSettingsSource {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || {
      info() {},
      warn() {},
    };

    this.enabled = Boolean(config.ai?.enabled);
    this.settingsFile = config.ai?.settingsFile || null;
    this.applyOverlay = Boolean(config.ai?.applyOverlay);
    this.applyKillSwitch = Boolean(config.ai?.applyKillSwitch);
    this.lastError = null;
  }

  defaultExecution() {
    const defaultSymbol = normalizeSymbol(this.config.execution.symbol);
    const configuredSymbols = toSymbolArray(this.config.execution.symbols, [defaultSymbol]);
    const symbols = configuredSymbols.length > 0 ? configuredSymbols : [defaultSymbol];
    return {
      enabled: Boolean(this.config.execution.enabled),
      symbol: symbols[0],
      symbols,
      orderAmountKrw: this.config.execution.orderAmountKrw,
      windowSec: this.config.execution.windowSec,
      cooldownSec: this.config.execution.cooldownSec,
    };
  }

  defaultStrategy() {
    const base = this.config?.strategy || {};
    return {
      name: normalizeStrategyName(base.name, "risk_managed_momentum"),
      defaultSymbol: normalizeSymbol(base.defaultSymbol || this.config?.execution?.symbol || "BTC_KRW"),
      candleInterval: normalizeInterval(base.candleInterval, "15m"),
      candleCount: toPositiveInt(base.candleCount, 120),
      breakoutLookback: toPositiveInt(base.breakoutLookback, 20),
      breakoutBufferBps: toPositiveNumber(base.breakoutBufferBps, 5),
      momentumLookback: toPositiveInt(base.momentumLookback, 24),
      volatilityLookback: toPositiveInt(base.volatilityLookback, 72),
      momentumEntryBps: toPositiveNumber(base.momentumEntryBps, 12),
      momentumExitBps: toPositiveNumber(base.momentumExitBps, 8),
      targetVolatilityPct: toPositiveNumber(base.targetVolatilityPct, 0.6),
      riskManagedMinMultiplier: toPositiveNumber(base.riskManagedMinMultiplier, 0.6),
      riskManagedMaxMultiplier: toPositiveNumber(base.riskManagedMaxMultiplier, 2.2),
      autoSellEnabled: toBoolean(base.autoSellEnabled, true),
      sellAllOnExit: toBoolean(base.sellAllOnExit, true),
      sellAllQtyPrecision: toPositiveInt(base.sellAllQtyPrecision, 8),
      baseOrderAmountKrw: toPositiveNumber(base.baseOrderAmountKrw, 5_000),
    };
  }

  defaultDecision() {
    return {
      mode: "filter",
      allowBuy: true,
      allowSell: true,
      forceAction: null,
      forceAmountKrw: null,
      forceOnce: true,
      note: null,
      symbols: {},
    };
  }

  defaultSnapshot(source = "defaults") {
    return {
      source,
      loadedAt: nowIso(),
      execution: this.defaultExecution(),
      strategy: this.defaultStrategy(),
      decision: this.defaultDecision(),
      overlay: null,
      controls: {
        killSwitch: null,
      },
    };
  }

  defaultTemplate() {
    const defaultMultiplier = Number.isFinite(Number(this.config.overlay?.defaultMultiplier))
      ? Number(this.config.overlay.defaultMultiplier)
      : 1;
    return {
      version: 1,
      updatedAt: nowIso(),
      execution: this.defaultExecution(),
      strategy: this.defaultStrategy(),
      decision: this.defaultDecision(),
      overlay: {
        multiplier: defaultMultiplier,
        score: null,
        regime: null,
        note: "set by ai",
      },
      controls: {
        killSwitch: false,
      },
    };
  }

  async init() {
    if (!this.enabled || !this.settingsFile) {
      return;
    }

    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    try {
      await fs.access(this.settingsFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }

      const template = this.defaultTemplate();
      await fs.writeFile(this.settingsFile, JSON.stringify(template, null, 2), "utf8");
      this.logger.info("ai settings template created", {
        file: this.settingsFile,
      });
    }
  }

  normalize(raw = {}) {
    const executionRaw = raw.execution || {};
    const defaults = this.defaultExecution();
    const strategyRaw = raw.strategy || {};
    const strategyDefaults = this.defaultStrategy();
    const decisionRaw = raw.decision || {};
    const decisionDefaults = this.defaultDecision();

    const execution = {
      enabled: toBoolean(executionRaw.enabled, defaults.enabled),
      symbol: normalizeSymbol(executionRaw.symbol || defaults.symbol),
      symbols: [],
      orderAmountKrw: toPositiveNumber(executionRaw.orderAmountKrw, defaults.orderAmountKrw),
      windowSec: toPositiveInt(executionRaw.windowSec, defaults.windowSec),
      cooldownSec: toNonNegativeInt(executionRaw.cooldownSec, defaults.cooldownSec),
    };
    const symbols = toSymbolArray(executionRaw.symbols, defaults.symbols || [execution.symbol]);
    if (execution.symbol && !symbols.includes(execution.symbol)) {
      symbols.unshift(execution.symbol);
    }
    execution.symbols = symbols.length > 0 ? symbols : [execution.symbol];
    execution.symbol = execution.symbols[0];

    const strategy = {
      name: normalizeStrategyName(strategyRaw.name, strategyDefaults.name),
      defaultSymbol: normalizeSymbol(strategyRaw.defaultSymbol || execution.symbol || strategyDefaults.defaultSymbol),
      candleInterval: normalizeInterval(strategyRaw.candleInterval, strategyDefaults.candleInterval),
      candleCount: toPositiveInt(strategyRaw.candleCount, strategyDefaults.candleCount),
      breakoutLookback: toPositiveInt(strategyRaw.breakoutLookback, strategyDefaults.breakoutLookback),
      breakoutBufferBps: toPositiveNumber(strategyRaw.breakoutBufferBps, strategyDefaults.breakoutBufferBps),
      momentumLookback: toPositiveInt(strategyRaw.momentumLookback, strategyDefaults.momentumLookback),
      volatilityLookback: toPositiveInt(strategyRaw.volatilityLookback, strategyDefaults.volatilityLookback),
      momentumEntryBps: toPositiveNumber(strategyRaw.momentumEntryBps, strategyDefaults.momentumEntryBps),
      momentumExitBps: toPositiveNumber(strategyRaw.momentumExitBps, strategyDefaults.momentumExitBps),
      targetVolatilityPct: toPositiveNumber(strategyRaw.targetVolatilityPct, strategyDefaults.targetVolatilityPct),
      riskManagedMinMultiplier: toPositiveNumber(
        strategyRaw.riskManagedMinMultiplier,
        strategyDefaults.riskManagedMinMultiplier,
      ),
      riskManagedMaxMultiplier: toPositiveNumber(
        strategyRaw.riskManagedMaxMultiplier,
        strategyDefaults.riskManagedMaxMultiplier,
      ),
      autoSellEnabled: toBoolean(strategyRaw.autoSellEnabled, strategyDefaults.autoSellEnabled),
      sellAllOnExit: toBoolean(strategyRaw.sellAllOnExit, strategyDefaults.sellAllOnExit),
      sellAllQtyPrecision: toPositiveInt(strategyRaw.sellAllQtyPrecision, strategyDefaults.sellAllQtyPrecision),
      baseOrderAmountKrw: toPositiveNumber(strategyRaw.baseOrderAmountKrw, strategyDefaults.baseOrderAmountKrw),
    };

    const controls = {
      killSwitch: this.applyKillSwitch ? toBoolean(raw?.controls?.killSwitch, null) : null,
    };

    const overlay = this.applyOverlay ? normalizeOverlay(raw.overlay) : null;
    const decision = normalizeDecision(decisionRaw, decisionDefaults);
    return {
      source: "ai_settings_file",
      loadedAt: nowIso(),
      execution,
      strategy,
      decision,
      overlay,
      controls,
    };
  }

  async read() {
    if (!this.enabled || !this.settingsFile) {
      return this.defaultSnapshot("disabled");
    }

    try {
      const rawText = await fs.readFile(this.settingsFile, "utf8");
      const parsed = rawText.trim() ? JSON.parse(rawText) : {};
      this.lastError = null;
      return this.normalize(parsed);
    } catch (error) {
      if (this.lastError !== error.message) {
        this.lastError = error.message;
        this.logger.warn("failed to read ai settings; fallback to defaults", {
          file: this.settingsFile,
          reason: error.message,
        });
      }
      return this.defaultSnapshot("read_error_fallback");
    }
  }
}
