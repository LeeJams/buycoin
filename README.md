# buycoin-trader (Execution-First Orthodox Architecture)

An execution-first Bithumb trading system rebuilt with orthodox architecture:

- Deterministic execution path (rule-based, low-latency)
- AI/ML is **not** in execution timing path
- AI is only an **overlay cache** for position sizing

## Core Principle

Execution is strictly:

`MarketData -> SignalEngine -> RiskEngine -> ExecutionEngine`

AI/ML role:

- allowed: regime score, risk-on/off score, position multiplier cache
- not allowed: real-time order trigger / order timing decision

## What Changed

- Removed AI decisioning from order trigger path
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
- Overlay: `OVERLAY_*` (AI/ML cache settings)

## Quick Start

### 0) Find and apply safest top-return setup (recommended first)

```bash
npm run optimize
```

This command:

- fetches recent candles for `OPTIMIZER_SYMBOLS`
- runs grid-search on momentum parameters
- keeps only candidates that pass safety constraints
  - max drawdown
  - min trade count
  - min win rate
  - min profit factor
  - min return
- writes report to `OPTIMIZER_REPORT_FILE`
- applies best candidate to `AI_SETTINGS_FILE` (`execution.symbol` + `strategy.*`)

Hourly re-optimization (daemon runtime):

- `OPTIMIZER_REOPT_ENABLED=true`
- `OPTIMIZER_REOPT_INTERVAL_SEC=3600`

### 1) Run as execution service (daemon)

```bash
npm start
```

The service uses `EXECUTION_*` values from `.env` and runs realtime windows continuously.
When enabled, it also reads AI runtime settings from `.trader/ai-settings.json` every window.
You can set multi-symbol runtime defaults with `EXECUTION_SYMBOLS=BTC_KRW,ETH_KRW,USDT_KRW`.

### 2) One-shot execution test (same runtime path)

```bash
npm run start:once
```

### 3) Endpoint smoke check (read-only by default)

```bash
npm run smoke
```

This verifies:

- private REST: accounts/chance/orders list
- public REST: ticker + minute/day/week/month candles
- public WS: ticker/trade/orderbook
- private WS: myAsset/myOrder connection-open check

### 4) Optional write smoke (place+cancel)

```bash
npm run smoke:write
```

Write smoke is protected by explicit env confirmation:

- `SMOKE_ENABLE_WRITES=true`
- `SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND`

It places a deep limit buy and cancels it, then checks follow-up order status.

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

You can still switch to legacy breakout with:

```bash
STRATEGY_NAME=breakout
```

## Overlay (AI/ML Output Cache)

Set by external process (AI agent, batch job, research model) in `AI_SETTINGS_FILE`.

Execution reads overlay with timeout guard:

- If overlay is late/stale, fallback multiplier is used
- Execution never waits indefinitely for AI

## AI Runtime Settings File

AI can control execution settings by writing `AI_SETTINGS_FILE` (default: `.trader/ai-settings.json`).
The daemon reads this file on each execution window.
For concurrent multi-symbol execution, set `execution.symbols` (array or comma-separated string).

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
    "cooldownSec": 30,
    "dryRun": false
  },
  "strategy": {
    "name": "risk_managed_momentum",
    "defaultSymbol": "BTC_KRW",
    "candleInterval": "15m",
    "candleCount": 200,
    "momentumLookback": 36,
    "volatilityLookback": 96,
    "momentumEntryBps": 16,
    "momentumExitBps": 10,
    "targetVolatilityPct": 0.35,
    "riskManagedMinMultiplier": 0.4,
    "riskManagedMaxMultiplier": 1.8,
    "autoSellEnabled": true,
    "baseOrderAmountKrw": 5000
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

- AI settings changes are applied at the next window boundary, not per tick.
- `strategy.*` updates are also applied at window boundary (signal engine is rebuilt safely).
- Execution path remains deterministic (`MarketData -> Signal -> Risk -> Execution`).
- In live mode, startup includes account preflight (`account list`) to verify your credentials/account access.

## Safety-First Best Return Search

There is no universal "always best" strategy. This project uses a constrained optimizer:

- objective: maximize score derived from return, drawdown, sharpe, win-rate
- hard safety filter:
  - `OPTIMIZER_MAX_DRAWDOWN_PCT`
  - `OPTIMIZER_MIN_TRADES`
  - `OPTIMIZER_MIN_WIN_RATE_PCT`
  - `OPTIMIZER_MIN_PROFIT_FACTOR`
  - `OPTIMIZER_MIN_RETURN_PCT`
- output:
  - `.trader/optimizer-report.json` with top candidates
  - `.trader/ai-settings.json` updated with chosen symbol + parameters

Optional auto-apply on service start:

```bash
OPTIMIZER_APPLY_ON_START=true npm start
```

Daemon re-optimization cadence (during runtime loop):

```bash
OPTIMIZER_REOPT_ENABLED=true
OPTIMIZER_REOPT_INTERVAL_SEC=3600
```

## No CLI Mode

- CLI mode is intentionally removed.
- Runtime control is file-driven (`.env` + `AI_SETTINGS_FILE`).
- Runtime observability is log-driven (JSON logs to stdout/stderr).
- Runtime state is persisted in `TRADER_STATE_FILE` (default `.trader/state.json`).

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

Generate aggregated report:

```bash
npm run audit:report
```

Report includes:

- endpoint-level success/fail counts
- average/p95 latency
- top error messages

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
