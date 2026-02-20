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

## Runtime

- Execution service: `npm start`
- You can set default multi-symbol execution via `.env` with `EXECUTION_SYMBOLS=BTC_KRW,ETH_KRW,...`.
- Runtime writes curated tradable symbols to `.trader/market-universe.json`.

## AI Settings Bridge (runtime input for automation)

- Default file: `.trader/ai-settings.json`
- The daemon refreshes this file on a periodic snapshot cycle.
- Default refresh cadence is 30-60 minutes (`AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`).
- AI can control symbol/order notional/window/cooldown/kill-switch by updating this file.
- For concurrent multi-symbol execution, set `execution.symbols` (array or comma-separated string).
- Requested symbols are intersected with `.trader/market-universe.json` (liquidity/quality filter).
- Tune universe strictness via `MARKET_UNIVERSE_*` in `.env`.

Example:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "enabled": true,
    "symbol": "USDT_KRW",
    "symbols": ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
    "orderAmountKrw": 7000,
    "windowSec": 180,
    "cooldownSec": 20
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
    "sellAllOnExit": true,
    "sellAllQtyPrecision": 8,
    "baseOrderAmountKrw": 7000
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
        "forceAmountKrw": 7000
      }
    }
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
npm start
```

CLI mode has been removed. Control is file-driven (`.env` + `AI_SETTINGS_FILE`).

## Execution Rules

- BUY signal: executes market buy immediately.
- SELL signal: executes market sell immediately when `STRATEGY_AUTO_SELL_ENABLED=true`.
- If `STRATEGY_SELL_ALL_ON_EXIT=true`, SELL uses available asset quantity (not fixed KRW amount).
- AI decision policy:
  - `decision.mode=filter`: AI can block BUY/SELL (`allowBuy`, `allowSell`)
  - `decision.mode=override`: AI can force one action per window (`forceAction`, `forceAmountKrw`)
  - symbol-level override is supported via `decision.symbols.<SYMBOL>`
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

## HTTP Audit Trail

- audit toggle: `TRADER_HTTP_AUDIT_ENABLED`
- audit file: `TRADER_HTTP_AUDIT_FILE` (default `.trader/http-audit.jsonl`)
- auto rotation: `TRADER_HTTP_AUDIT_MAX_BYTES`, `TRADER_HTTP_AUDIT_PRUNE_RATIO`, `TRADER_HTTP_AUDIT_CHECK_EVERY`

State retention caps (to avoid oversized `.trader/state.json`):

- `TRADER_STATE_KEEP_LATEST_ONLY` (when `true`, keep latest snapshots + open orders)
- `TRADER_RETENTION_CLOSED_ORDERS`
- `TRADER_RETENTION_ORDERS`
- `TRADER_RETENTION_ORDER_EVENTS`
- `TRADER_RETENTION_STRATEGY_RUNS`
- `TRADER_RETENTION_BALANCE_SNAPSHOTS`
- `TRADER_RETENTION_FILLS`

Daily loss baseline:

- if `TRADER_INITIAL_CAPITAL_KRW` is set, this value is baseline
- else first observed daily equity is baseline

## Notes

- Live mode needs valid Bithumb keys and IP allowlist.
- Bithumb rate limits are respected via built-in limiter.
- WebSocket connect limit is enforced (`BITHUMB_WS_CONNECT_MAX_PER_SEC`, default 5/s).
