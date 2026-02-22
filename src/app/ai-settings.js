import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSymbol } from "../config/defaults.js";
import { nowIso } from "../lib/time.js";

const ALLOWED_STRATEGY_NAMES = new Set(["risk_managed_momentum", "breakout"]);

// Safe ranges for strategy parameters per README AI Operator Contract.
// Values outside these ranges silently break strategy behavior (e.g. momentumEntryBps>30 disables buying).
const STRATEGY_SAFE_RANGES = {
  momentumLookback:         { min: 12,   max: 72   },
  volatilityLookback:       { min: 48,   max: 144  },
  momentumEntryBps:         { min: 6,    max: 30   },
  momentumExitBps:          { min: 4,    max: 20   },
  targetVolatilityPct:      { min: 0.30, max: 1.20 },
  riskManagedMinMultiplier: { min: 0.40, max: 1.00 },
  riskManagedMaxMultiplier: { min: 1.20, max: 2.50 },
};

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

function clampRange(value, min, max, fallback, label, logger = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return value;
  }
  const clamped = Math.min(Math.max(value, min), max);
  if (clamped !== value && logger) {
    logger.warn("ai settings: value clamped", {
      field: label,
      received: value,
      clamped,
      min,
      max,
    });
  }
  return clamped;
}

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

function normalizeRuntimeMeta(raw = {}) {
  const meta = raw && typeof raw === "object" ? raw : null;
  if (!meta) {
    return null;
  }

  const source = typeof meta.source === "string" && meta.source.trim() !== ""
    ? String(meta.source).trim()
    : null;
  const approvedBy = typeof meta.approvedBy === "string" && meta.approvedBy.trim() !== ""
    ? String(meta.approvedBy).trim()
    : null;
  const runId = meta.runId !== undefined && meta.runId !== null
    ? String(meta.runId)
    : null;
  const approvedAt = toNullableNumber(meta.approvedAt);
  const version = typeof meta.version === "string" && meta.version.trim() !== ""
    ? String(meta.version).trim()
    : null;

  if (source === null && approvedBy === null && runId === null && approvedAt === null && version === null) {
    return null;
  }

  return {
    source,
    approvedBy,
    runId,
    approvedAt,
    version,
  };
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
      maxSymbolsPerWindow: toPositiveInt(
        this.config.execution.maxSymbolsPerWindow,
        3,
      ),
      maxOrderAttemptsPerWindow: toPositiveInt(
        this.config.execution.maxOrderAttemptsPerWindow,
        1,
      ),
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
      baseOrderAmountKrw: toPositiveNumber(base.baseOrderAmountKrw, 20_000),
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
      meta: null,
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
      meta: null,
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
      maxSymbolsPerWindow: toPositiveInt(executionRaw.maxSymbolsPerWindow, defaults.maxSymbolsPerWindow),
      maxOrderAttemptsPerWindow: toPositiveInt(executionRaw.maxOrderAttemptsPerWindow, defaults.maxOrderAttemptsPerWindow),
    };
    const riskMinOrder = toPositiveNumber(this.config?.risk?.minOrderNotionalKrw, 20_000);
    const riskMaxOrder = toPositiveNumber(this.config?.risk?.maxOrderNotionalKrw, 300_000);
    execution.orderAmountKrw = clampRange(
      execution.orderAmountKrw,
      riskMinOrder,
      riskMaxOrder,
      execution.orderAmountKrw,
      "execution.orderAmountKrw",
      this.logger,
    );
    execution.windowSec = clampRange(
      execution.windowSec,
      5,
      86_400,
      execution.windowSec,
      "execution.windowSec",
      this.logger,
    );
    execution.cooldownSec = clampRange(
      execution.cooldownSec,
      0,
      600,
      execution.cooldownSec,
      "execution.cooldownSec",
      this.logger,
    );
    execution.maxSymbolsPerWindow = clampRange(
      execution.maxSymbolsPerWindow,
      1,
      20,
      execution.maxSymbolsPerWindow,
      "execution.maxSymbolsPerWindow",
      this.logger,
    );
    execution.maxOrderAttemptsPerWindow = clampRange(
      execution.maxOrderAttemptsPerWindow,
      1,
      20,
      execution.maxOrderAttemptsPerWindow,
      "execution.maxOrderAttemptsPerWindow",
      this.logger,
    );
    const hasExplicitSymbol = executionRaw.symbol !== undefined && executionRaw.symbol !== null && String(executionRaw.symbol).trim() !== "";
    const explicitSymbol = hasExplicitSymbol
      ? normalizeSymbol(executionRaw.symbol)
      : null;
    const symbolFallback = explicitSymbol
      ? [explicitSymbol]
      : defaults.symbols || [execution.symbol];
    const symbols = toSymbolArray(executionRaw.symbols, symbolFallback);
    if (hasExplicitSymbol && explicitSymbol && !symbols.includes(explicitSymbol)) {
      symbols.unshift(explicitSymbol);
    }
    execution.symbols = symbols.length > 0 ? symbols : [execution.symbol];
    execution.symbol = hasExplicitSymbol && explicitSymbol ? explicitSymbol : execution.symbols[0];

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

    for (const [field, range] of Object.entries(STRATEGY_SAFE_RANGES)) {
      const value = strategy[field];
      if (typeof value !== "number") continue;
      const clamped = Math.max(range.min, Math.min(range.max, value));
      if (clamped !== value) {
        this.logger.warn("ai settings: strategy parameter out of safe range, clamping", {
          field,
          received: value,
          clamped,
          safeMin: range.min,
          safeMax: range.max,
        });
        strategy[field] = clamped;
      }
    }

    const controls = {
      killSwitch: this.applyKillSwitch ? toBoolean(raw?.controls?.killSwitch, null) : null,
    };

    const overlay = this.applyOverlay ? normalizeOverlay(raw.overlay) : null;
    const decision = normalizeDecision(decisionRaw, decisionDefaults);
    const meta = normalizeRuntimeMeta(raw.meta);
    if (decision.forceAmountKrw !== null) {
      decision.forceAmountKrw = clampRange(
        decision.forceAmountKrw,
        Math.max(riskMinOrder, execution.orderAmountKrw * 0.1),
        execution.orderAmountKrw * 50,
        decision.forceAmountKrw,
        "decision.forceAmountKrw",
        this.logger,
      );
    }

    return {
      source: "ai_settings_file",
      loadedAt: nowIso(),
      meta,
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
