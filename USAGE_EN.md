# buycoin-trader Usage (EN)

## Architecture

Orthodox execution pipeline:

1. Market data fetch
2. Rule-based signal generation (risk-managed momentum by default)
3. Risk checks
4. Immediate execution

AI/ML is only used as an overlay cache for position multiplier.
AI/ML is not used to trigger or time orders.

## Setup

```bash
cd ./buycoin
npm install
```

Configure `.env` from `.env.example`.

## Run Modes

- Safe-constrained optimization + apply: `npm run optimize`
- Execution service (default): `npm start`
- One-shot execution check: `npm run start:once`
- Endpoint smoke check (read-only): `npm run smoke`
- Endpoint smoke check (write place+cancel): `npm run smoke:write`
- HTTP audit summary report: `npm run audit:report`
- Paper mode default starting cash: `1,000,000 KRW` (override with `TRADER_PAPER_INITIAL_CASH_KRW`)

## AI Settings Bridge (runtime input for automation)

- Default file: `.trader/ai-settings.json`
- The daemon reads this file at each execution window.
- AI can control symbol/order notional/window/cooldown/dry-run/kill-switch by updating this file.

Example:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "enabled": true,
    "symbol": "USDT_KRW",
    "orderAmountKrw": 7000,
    "windowSec": 180,
    "cooldownSec": 20,
    "dryRun": false
  },
  "strategy": {
    "name": "risk_managed_momentum",
    "defaultSymbol": "USDT_KRW",
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
    "baseOrderAmountKrw": 7000
  },
  "overlay": {
    "multiplier": 0.8,
    "score": -0.3,
    "regime": "risk_off",
    "note": "macro risk"
  },
  "controls": {
    "killSwitch": false
  }
}
```

## Run Commands

```bash
npm run optimize
npm start
npm run start:once
npm run smoke
npm run smoke:write
npm run audit:report
```

CLI mode has been removed. Control is file-driven (`.env` + `AI_SETTINGS_FILE`).

## Safe + Return Optimization

`npm run optimize` does:

1. fetch candles for `OPTIMIZER_SYMBOLS`
2. grid-search momentum parameters
3. prioritize candidates that pass safety constraints
   - max drawdown, min trades, min win rate, min profit factor, min return
4. persist outputs
   - report: `OPTIMIZER_REPORT_FILE` (default `.trader/optimizer-report.json`)
   - applied runtime settings: `AI_SETTINGS_FILE` (`execution.symbol`, `strategy.*`)

Automatic re-optimization during daemon runtime (hourly):

- `OPTIMIZER_REOPT_ENABLED=true`
- `OPTIMIZER_REOPT_INTERVAL_SEC=3600`

To auto-run optimizer before daemon loop:

```bash
OPTIMIZER_APPLY_ON_START=true npm start
```

## Execution Rules

- BUY signal: executes market buy immediately (unless `--dry-run`).
- SELL signal: executes market sell immediately when `STRATEGY_AUTO_SELL_ENABLED=true`.
- HOLD signal: no order.
- Final size uses `baseAmount * signalRiskMultiplier * overlayMultiplier`.
- If overlay times out or is stale, fallback multiplier is used.
- Real-time ticker mode uses Bithumb WebSocket public endpoint (`wss://ws-api.bithumb.com/websocket/v1`).
- WebSocket coverage includes:
  - public: `ticker`, `trade`, `orderbook`
  - private: `myOrder`, `myAsset`

## Risk Controls

- Min/Max notional checks
- Max open orders
- Max exposure
- Max daily loss
- Kill switch

## Smoke Write Guard

`npm run smoke:write` requires explicit confirmation and runs only in live mode:

- `SMOKE_ENABLE_WRITES=true`
- `SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND`
- `TRADER_PAPER_MODE=false`

The write smoke flow is:

1. fetch chance and min notional
2. place deep limit buy
3. cancel order
4. read back order state

## HTTP Audit Trail

- audit toggle: `TRADER_HTTP_AUDIT_ENABLED`
- audit file: `TRADER_HTTP_AUDIT_FILE` (default `.trader/http-audit.jsonl`)
- report command: `npm run audit:report`

Daily loss baseline:

- if `TRADER_INITIAL_CAPITAL_KRW` is set, this value is baseline
- else first observed daily equity is baseline

## Notes

- Live mode needs valid Bithumb keys and IP allowlist.
- Bithumb rate limits are respected via built-in limiter.
- WebSocket connect limit is enforced (`BITHUMB_WS_CONNECT_MAX_PER_SEC`, default 5/s).
