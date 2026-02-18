# buycoin-trader (Execution-First Orthodox Architecture)

An execution-first Bithumb trading system rebuilt with orthodox architecture:

- Deterministic execution path (rule-based, low-latency)
- AI is a **policy/settings supervisor** (not per-tick execution trigger)
- AI writes settings snapshot; engine executes deterministically from that snapshot

## Core Principle

Execution is strictly:

`MarketData -> SignalEngine -> RiskEngine -> ExecutionEngine`

AI/ML role:

- allowed: periodic strategy/policy tuning, regime score, position multiplier cache
- not allowed: per-tick inference in order timing path

## What Changed

- Removed per-tick AI decisioning from order trigger path
- Added timeout-guarded overlay cache (`OVERLAY_TIMEOUT_MS`)
- Strategy run is immediate and rule-based
- Added real-time WebSocket ticker mode (`socket.md` spec)
- Primary runtime is daemon execution (`npm start`)

## Requirements

- Node.js 20+
- Bithumb API key/secret for live mode

## Install

```bash
cd ./buycoin
npm install
```

## Environment

Copy from `.env.example` and fill keys.

Key groups:

- Exchange: `BITHUMB_*`
- Runtime: `TRADER_*`, `TZ`
- Strategy: `STRATEGY_*` (default: risk-managed momentum)
- Risk: `RISK_*`, `TRADER_INITIAL_CAPITAL_KRW`
- AI bridge: `AI_SETTINGS_*` (AI writes runtime settings file)
- Market universe: `MARKET_UNIVERSE_*` (liquidity/quality filtered tradable symbols)
- Overlay: `OVERLAY_*` (AI/ML cache settings)

## Quick Start

### 1) Run as execution service (daemon)

```bash
npm start
```

The service uses `EXECUTION_*` values from `.env` and runs realtime windows continuously.
When enabled, it refreshes AI runtime settings snapshot from `.trader/ai-settings.json` periodically.
Default refresh cadence is 30-60 minutes (`AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`).
It also refreshes a curated KRW market universe snapshot in `.trader/market-universe.json`.
Symbols outside this universe are automatically filtered out from `execution.symbols`.
You can set multi-symbol runtime defaults with `EXECUTION_SYMBOLS=BTC_KRW,ETH_KRW,USDT_KRW`.

## Paper Trading

- `TRADER_PAPER_MODE=true` enables simulated execution.
- Default paper starting cash is `1,000,000 KRW`.
- You can override with `TRADER_PAPER_INITIAL_CASH_KRW`.
- In paper mode, `account list` returns simulated balances from local state.

## Default Trading Strategy

Default strategy is `risk_managed_momentum`.

- Signal: momentum up -> `BUY`, momentum down -> `SELL`, otherwise `HOLD`
- Position sizing: volatility-targeted risk multiplier
- Final order amount: `base amount * signal risk multiplier * AI overlay multiplier`
- Auto sell is enabled by default (`STRATEGY_AUTO_SELL_ENABLED=true`)
- Exit sell defaults to "sell-all using available base asset qty" (`STRATEGY_SELL_ALL_ON_EXIT=true`)
- Aggressive baseline defaults:
  - `momentumLookback=24`
  - `volatilityLookback=72`
  - `momentumEntryBps=12`
  - `momentumExitBps=8`
  - `targetVolatilityPct=0.6`
  - `riskManagedMinMultiplier=0.6`
  - `riskManagedMaxMultiplier=2.2`

## Overlay (AI/ML Output Cache)

Set by external process (AI agent, batch job, research model) in `AI_SETTINGS_FILE`.

Execution reads overlay with timeout guard:

- If overlay is late/stale, fallback multiplier is used
- Execution never waits indefinitely for AI

## AI Runtime Settings File

AI can control execution settings by writing `AI_SETTINGS_FILE` (default: `.trader/ai-settings.json`).
The daemon loads an AI settings snapshot and refreshes it periodically.
Default refresh range is 30-60 minutes (`AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`).
For concurrent multi-symbol execution, set `execution.symbols` (array or comma-separated string).
The runtime intersects requested symbols with `.trader/market-universe.json` and only executes allowed ones.

Default schema:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "enabled": true,
    "symbol": "BTC_KRW",
    "symbols": ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
    "orderAmountKrw": 5000,
    "windowSec": 300,
    "cooldownSec": 30
  },
  "strategy": {
    "name": "risk_managed_momentum",
    "defaultSymbol": "BTC_KRW",
    "candleInterval": "15m",
    "candleCount": 200,
    "momentumLookback": 24,
    "volatilityLookback": 72,
    "momentumEntryBps": 12,
    "momentumExitBps": 8,
    "targetVolatilityPct": 0.6,
    "riskManagedMinMultiplier": 0.6,
    "riskManagedMaxMultiplier": 2.2,
    "autoSellEnabled": true,
    "sellAllOnExit": true,
    "sellAllQtyPrecision": 8,
    "baseOrderAmountKrw": 5000
  },
  "decision": {
    "mode": "filter",
    "allowBuy": true,
    "allowSell": true,
    "forceAction": null,
    "forceAmountKrw": null,
    "forceOnce": true,
    "symbols": {
      "BTC_KRW": {
        "mode": "override",
        "forceAction": "BUY",
        "forceAmountKrw": 7000,
        "forceOnce": true
      }
    }
  },
  "overlay": {
    "multiplier": 1.0,
    "score": null,
    "regime": "risk_on",
    "note": "set by ai"
  },
  "controls": {
    "killSwitch": false
  }
}
```

Notes:

- AI settings changes are applied on the next AI snapshot refresh cycle (default 30-60 minutes), not per tick.
- Recommended AI update cadence is every 30-60 minutes.
- If no strategy/policy change is needed, keep the same `ai-settings.json` values.
- `strategy.*` updates are applied safely when refreshed (signal engine is rebuilt safely).
- Refresh cadence is configurable with `AI_SETTINGS_REFRESH_MIN_SEC` / `AI_SETTINGS_REFRESH_MAX_SEC`.
- `decision.mode`:
  - `rule`/`filter`: execute only signal-based actions (with AI allow/deny filters)
  - `override`: allow AI-forced action (`BUY`/`SELL`) for the window
- Execution path remains deterministic (`MarketData -> Signal -> Risk -> Execution`).
- In live mode, startup includes account preflight (`account list`) to verify your credentials/account access.

## AI Operator Contract (for OpenClaw/LLM)

This section is the canonical contract for an AI that manages runtime behavior.

### Role

AI acts as a **strategy/policy supervisor**, not as a per-tick execution engine.

### Cadence

- Run market/account review every 30-60 minutes.
- If no meaningful change is needed, keep the existing `ai-settings.json` as-is.
- Emergency updates (for example kill switch) can be written immediately.

### Read Inputs (AI side)

- `.env` for hard limits and runtime configuration
- `.trader/state.json` for latest balances/holdings/open orders/system state
- `.trader/http-audit.jsonl` for API failures, rate-limit pressure, and latency
- process logs (stdout/stderr) for runtime health

### Write Output (AI side)

- Target file: `.trader/ai-settings.json` only
- Write a full valid JSON object (`version: 1`, `updatedAt` in ISO-8601 UTC)
- Prefer atomic replace (`tmp` write + rename) to avoid partial-file reads

### Control Priorities

1. Safety first: exposure/loss controls over return optimization
2. Keep execution deterministic: avoid frequent oscillation of settings
3. Prefer `decision.mode=filter`; use `override` only with explicit conviction
4. Use `controls.killSwitch=true` immediately for abnormal conditions

### Field Guardrails for AI

| Field | Rule |
| --- | --- |
| `execution.enabled` | Keep `true` in normal operations; set `false` only for intentional pause |
| `execution.symbols` | Use normalized symbols and prefer values from `.trader/market-universe.json` |
| `execution.orderAmountKrw` | Must be positive and should satisfy exchange/risk minimum notional |
| `strategy.name` | Use supported strategy (`risk_managed_momentum` recommended) |
| `decision.mode` | `filter` (default), `rule`, or `override` |
| `decision.forceAction` | Use only with `override`; value `BUY` or `SELL` |
| `decision.forceOnce` | Keep `true` for one-shot forced action |
| `overlay.multiplier` | Positive multiplier; final size is still bounded by risk engine |
| `controls.killSwitch` | `true` means immediate trading halt behavior |

### Propagation Timing

- AI updates are not applied per tick.
- New settings are applied on next AI snapshot refresh cycle (default 30-60 minutes).
- Refresh range is controlled by:
  - `AI_SETTINGS_REFRESH_MIN_SEC`
  - `AI_SETTINGS_REFRESH_MAX_SEC`

### AI Runbook (What AI should do)

Run this loop every 30-60 minutes.

1. Read inputs
   - `.trader/market-universe.json` (allowed tradable symbols)
   - `.trader/state.json` (cash, holdings, open orders, last runs)
   - `.trader/http-audit.jsonl` (API errors, latency, rate-limit pressure)
   - runtime logs (latest execution window summaries)
2. Build tradable set
   - start from `market-universe.symbols`
   - keep currently held symbols included (for sell/exit handling)
   - set `execution.symbols` from this set (recommended 4-10 symbols)
3. Decide market regime and policy
   - set `overlay.regime` to `risk_on`, `neutral`, or `risk_off`
   - set `overlay.multiplier` by regime:
     - `risk_off`: `0.60-0.95`
     - `neutral`: `0.90-1.10`
     - `risk_on`: `1.00-1.35`
   - default to `decision.mode=filter`
   - block buys per symbol when short-term momentum is clearly negative, but keep sells enabled for held coins
4. Tune strategy within safe range
   - `strategy.momentumLookback`: `12-72`
   - `strategy.volatilityLookback`: `48-144`
   - `strategy.momentumEntryBps`: `6-30`
   - `strategy.momentumExitBps`: `4-20`
   - `strategy.targetVolatilityPct`: `0.30-1.20`
   - `strategy.riskManagedMinMultiplier`: `0.40-1.00`
   - `strategy.riskManagedMaxMultiplier`: `1.20-2.50`
5. Decide whether to write
   - if no material change, do not write file
   - material change examples:
     - `execution.symbols` changed
     - `execution.orderAmountKrw` changed by >= 10%
     - any `strategy.*` parameter changed
     - `overlay.multiplier` changed by >= 0.05
     - `decision.*` changed
     - `controls.killSwitch` changed
6. Write output safely
   - update only `.trader/ai-settings.json`
   - keep `version=1`
   - set `updatedAt` to current UTC ISO timestamp
   - write with atomic replace (`tmp` file then rename)
7. Self-validate after write
   - file is valid JSON
   - every symbol format is `BASE_KRW`
   - `execution.symbols` is a subset of `.trader/market-universe.json`
   - `execution.orderAmountKrw` respects risk/env limits

### AI No-Do Rules

- Do not edit `.env` during normal operation.
- Do not write orders directly; only write policy/settings snapshot.
- Do not use symbols outside `.trader/market-universe.json` unless explicitly force-included by env.
- Do not disable sells globally while holdings exist, unless kill switch policy requires full freeze.

## Curated Market Universe

To avoid illiquid or questionable symbols while still scanning many Bithumb markets:

- Source: `/v1/market/all` + `/v1/ticker`
- Scope: KRW quote markets
- Filter defaults:
  - `MARKET_UNIVERSE_MIN_ACC_TRADE_VALUE_24H_KRW=20000000000`
  - `MARKET_UNIVERSE_MIN_BASE_ASSET_LENGTH=2`
  - `market_warning=NONE`
- Output snapshot: `.trader/market-universe.json`
- Runtime behavior: symbols not in this snapshot are skipped automatically
- Manual controls:
  - force-include: `MARKET_UNIVERSE_INCLUDE_SYMBOLS`
  - force-exclude: `MARKET_UNIVERSE_EXCLUDE_SYMBOLS`

## No CLI Mode

- CLI mode is intentionally removed.
- Runtime control is file-driven (`.env` + `AI_SETTINGS_FILE`).
- Runtime observability is log-driven (JSON logs to stdout/stderr).
- Runtime state is persisted in `TRADER_STATE_FILE` (default `.trader/state.json`).
- State collections are retention-capped (see `TRADER_RETENTION_*`).
- Set `TRADER_STATE_KEEP_LATEST_ONLY=true` to keep only latest snapshots + open orders (+ a small closed-order tail).

## WebSocket Coverage

Implemented channels (`bithumb/socket.md`):

- Public: `ticker`, `trade`, `orderbook`
- Private: `myOrder`, `myAsset`

Default endpoints:

- Public: `BITHUMB_WS_PUBLIC_URL=wss://ws-api.bithumb.com/websocket/v1`
- Private: `BITHUMB_WS_PRIVATE_URL=wss://ws-api.bithumb.com/websocket/v1/private`

Private streams use JWT header auth (`authorization: Bearer ...`) and documented error frames are surfaced as runtime errors.

## HTTP Audit Log

Each exchange HTTP call is logged to JSONL audit trail:

- enable/disable: `TRADER_HTTP_AUDIT_ENABLED`
- file path: `TRADER_HTTP_AUDIT_FILE` (default `.trader/http-audit.jsonl`)
- auto rotation: `TRADER_HTTP_AUDIT_MAX_BYTES`, `TRADER_HTTP_AUDIT_PRUNE_RATIO`, `TRADER_HTTP_AUDIT_CHECK_EVERY`

## Safety Controls

- `RISK_MIN_ORDER_NOTIONAL_KRW`
- `RISK_MAX_ORDER_NOTIONAL_KRW`
- `RISK_MAX_OPEN_ORDERS`
- `RISK_MAX_EXPOSURE_KRW`
- `RISK_MAX_DAILY_LOSS_KRW`
- `TRADER_INITIAL_CAPITAL_KRW` (daily loss baseline)
- `kill-switch`

## Testing

```bash
npm run lint
npm test
```
