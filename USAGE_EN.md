# buycoin-trader Operations Guide (English, Detailed)

Document version: `2026-02-14`
Code path: `./` (project root)

## 0. Purpose
This guide is an end-to-end operational manual for `buycoin-trader`.

It is written for:
1. Human operators using the CLI directly
2. AI agents (OpenClaw) orchestrating the CLI

Only currently implemented features are documented. Gaps are listed in the limitations section.

## 1. 5-Minute Quick Start

### 1.1 Install
```bash
cd ./buycoin
npm install
```

### 1.2 Fill `.env`
File: `./.env`

Required:
```env
BITHUMB_ACCESS_KEY=your_access_key
BITHUMB_SECRET_KEY=your_secret_key
```

### 1.3 Basic health checks
```bash
node src/cli/index.js status --json
node src/cli/index.js health --json
node src/cli/index.js markets --symbol BTC_KRW --json
node src/cli/index.js order chance --symbol BTC_KRW --json
node src/cli/index.js strategy run --name rsi --symbol BTC_KRW --dry-run --json
```

### 1.4 Place a paper order
```bash
node src/cli/index.js paper on --json
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key quickstart-001 --json
```

### 1.5 Switch to live mode
```bash
node src/cli/index.js paper off --json
```

Manual mode (`OPENCLAW_AGENT=false`) live order example:
```bash
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key live-001 --confirm YES --json
```

OpenClaw mode (`OPENCLAW_AGENT=true`) bypasses `--confirm YES`.

## 2. Core Concepts

### 2.1 Execution modes
- `paper mode`:
  - No real exchange order submission
  - Order states are simulated in local state
- `live mode`:
  - Private Bithumb API calls are executed
  - Real orders/cancellations happen

### 2.2 State persistence
- Default file: `.trader/state.json`
- Stored domains:
  - settings (paper/kill-switch)
  - orders/orderEvents/fills
  - balancesSnapshot
  - dailyPnlBaseline
  - riskEvents
  - agentAudit
- Concurrency safety:
  - file lock (`.lock`) prevents write races

### 2.3 Idempotency
- Option: `--client-order-key`
- Reusing the same key returns existing order state
- Mandatory best practice for AI retries

### 2.4 Minimum order notional guardrail
- Risk variable: `RISK_MIN_ORDER_NOTIONAL_KRW`
- Default: `5000`
- Formula: `price * (amount / price)` = `amount`
- Example: `amount=1468` -> rejected before exchange call
- In live mode (`paper off`), before placing an order the system fetches `/v1/orders/chance` and applies:
  - buy side: `market.bid.min_total`
  - sell side: `market.ask.min_total`
- Effective minimum = `max(config minimum, exchange minimum)`.

### 2.5 Daily PnL baseline and loss-limit context
- Before each live order, risk context attempts private account snapshot fetch.
- Current KRW equity is estimated from:
  - KRW cash (`balance + locked`)
  - non-KRW holdings valued by `avgBuyPrice` when `unitCurrency=KRW`
- Baseline per trade date:
  - use `TRADER_INITIAL_CAPITAL_KRW` if set and valid
  - otherwise use first observed equity of the day
- Computed value: `dailyRealizedPnlKrw = currentEquityKrw - baselineEquityKrw`
- If private account fetch fails, latest `balancesSnapshot` is used as fallback.

### 2.6 RSI strategy execution
- Strategy name: `rsi`
- Entry point: `strategy run --name rsi`
- Signal rules:
  - `BUY` when RSI <= oversold
  - `SELL` when RSI >= overbought
  - otherwise `HOLD`
- Order behavior:
  - `--dry-run`: signal only, no order
  - non-dry-run: market buy only when signal is `BUY`

## 3. Project Layout

```text
.
├─ .env
├─ .env.example
├─ README.md
├─ USAGE_KO.md
├─ USAGE_EN.md
├─ src
│  ├─ cli/index.js
│  ├─ config/*
│  ├─ core/*
│  ├─ exchange/*
│  └─ lib/*
└─ test/*
```

## 4. Full Environment Variable Reference

### 4.1 Exchange/auth
| Variable | Required | Default | Description |
|---|---|---|---|
| `BITHUMB_ACCESS_KEY` | Yes (live) | `""` | Bithumb access key |
| `BITHUMB_SECRET_KEY` | Yes (live) | `""` | Bithumb secret key |
| `BITHUMB_BASE_URL` | No | `https://api.bithumb.com` | REST base URL |
| `BITHUMB_TIMEOUT_MS` | No | `5000` | HTTP timeout (ms) |
| `BITHUMB_MAX_RETRIES` | No | `4` | retry attempts |
| `BITHUMB_RETRY_BASE_MS` | No | `250` | retry backoff base (ms) |
| `BITHUMB_PUBLIC_MAX_PER_SEC` | No | `150` | max public requests per second |
| `BITHUMB_PRIVATE_MAX_PER_SEC` | No | `140` | max private requests per second |

### 4.2 Runtime
| Variable | Required | Default | Description |
|---|---|---|---|
| `TRADER_PAPER_MODE` | No | `true` | startup mode |
| `TRADER_STATE_FILE` | No | `.trader/state.json` | state file path |
| `TRADER_STATE_LOCK_STALE_MS` | No | `30000` | stale lock recovery threshold after restart (ms) |
| `TRADER_STARTUP_RECONCILE` | No | `true` | auto-reconcile `UNKNOWN_SUBMIT` on startup |
| `TRADER_DEFAULT_SYMBOL` | No | `BTC_KRW` | default symbol |
| `OPENCLAW_AGENT` | No | `false` | agent mode toggle |
| `TRADER_ENV_FILE` | No | `.env` | custom env file path |

### 4.3 AI symbol selection
| Variable | Required | Default | Description |
|---|---|---|---|
| `TRADER_AUTO_SELECT_MODE` | No | `momentum` | `momentum` or `volume` |
| `TRADER_AUTO_SELECT_CANDIDATES` | No | `BTC_KRW,ETH_KRW,XRP_KRW,SOL_KRW,DOGE_KRW` | candidate universe |

### 4.4 Risk
| Variable | Required | Default | Description |
|---|---|---|---|
| `RISK_MAX_CONCURRENT_ORDERS` | No | `5` | max active orders |
| `RISK_MIN_ORDER_NOTIONAL_KRW` | No | `5000` | minimum order notional |
| `RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL` | No | `""` | per-symbol minimum override (`USDT_KRW:1000,BTC_KRW:7000`) |
| `RISK_MAX_ORDER_NOTIONAL_KRW` | No | `300000` | maximum order notional |
| `RISK_DAILY_LOSS_LIMIT_KRW` | No | `500000` | daily loss cap |
| `TRADER_INITIAL_CAPITAL_KRW` | No | `""` | optional daily-PnL baseline capital |
| `RISK_AI_MAX_ORDER_NOTIONAL_KRW` | No | `100000` | max order notional for `--auto-symbol` orders |
| `RISK_AI_MAX_ORDERS_PER_WINDOW` | No | `3` | max number of `--auto-symbol` orders per window |
| `RISK_AI_ORDER_COUNT_WINDOW_SEC` | No | `60` | window size (sec) for AI order count cap |
| `RISK_AI_MAX_TOTAL_EXPOSURE_KRW` | No | `500000` | max projected total exposure for AI buy orders |
| `RISK_MAX_SLIPPAGE_BPS` | No | `30` | reserved |
| `TRADER_FEE_BPS` | No | `5` | reserved |

### 4.5 Strategy (RSI)
| Variable | Required | Default | Description |
|---|---|---|---|
| `STRATEGY_RSI_PERIOD` | No | `14` | RSI period |
| `STRATEGY_RSI_INTERVAL` | No | `15m` | candle interval |
| `STRATEGY_RSI_CANDLE_COUNT` | No | `100` | candle fetch count (min `period+1`) |
| `STRATEGY_RSI_OVERSOLD` | No | `30` | BUY threshold |
| `STRATEGY_RSI_OVERBOUGHT` | No | `70` | SELL threshold |
| `STRATEGY_DEFAULT_ORDER_AMOUNT_KRW` | No | `5000` | fallback order amount when strategy budget is omitted |

### 4.6 Resilience (Retry/Kill-Switch)
| Variable | Required | Default | Description |
|---|---|---|---|
| `TRADER_AUTO_RETRY_ENABLED` | No | `true` | enable automatic handling for `code=5/7` |
| `TRADER_AUTO_RETRY_ATTEMPTS` | No | `2` | retry/recovery attempts |
| `TRADER_AUTO_RETRY_DELAY_MS` | No | `1000` | retry/recovery delay (ms) |
| `TRADER_AUTO_KILL_SWITCH_ENABLED` | No | `true` | auto kill-switch on repeated failures |
| `TRADER_AUTO_KILL_SWITCH_FAILURE_THRESHOLD` | No | `3` | failure count threshold in window |
| `TRADER_AUTO_KILL_SWITCH_WINDOW_SEC` | No | `120` | failure aggregation window (sec) |
| `TRADER_UNKNOWN_SUBMIT_MAX_AGE_SEC` | No | `180` | protection threshold for long `UNKNOWN_SUBMIT` |

### 4.7 Example `.env`
```env
BITHUMB_ACCESS_KEY=...
BITHUMB_SECRET_KEY=...
BITHUMB_PUBLIC_MAX_PER_SEC=150
BITHUMB_PRIVATE_MAX_PER_SEC=140

TRADER_PAPER_MODE=true
TRADER_DEFAULT_SYMBOL=BTC_KRW
TRADER_STATE_FILE=.trader/state.json
TRADER_STATE_LOCK_STALE_MS=30000
TRADER_STARTUP_RECONCILE=true
OPENCLAW_AGENT=true

TRADER_AUTO_SELECT_MODE=momentum
TRADER_AUTO_SELECT_CANDIDATES=BTC_KRW,ETH_KRW,XRP_KRW,SOL_KRW,DOGE_KRW

RISK_MAX_CONCURRENT_ORDERS=5
RISK_MIN_ORDER_NOTIONAL_KRW=5000
RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL=USDT_KRW:1000,BTC_KRW:7000
RISK_MAX_ORDER_NOTIONAL_KRW=300000
RISK_DAILY_LOSS_LIMIT_KRW=500000
TRADER_INITIAL_CAPITAL_KRW=
RISK_AI_MAX_ORDER_NOTIONAL_KRW=100000
RISK_AI_MAX_ORDERS_PER_WINDOW=3
RISK_AI_ORDER_COUNT_WINDOW_SEC=60
RISK_AI_MAX_TOTAL_EXPOSURE_KRW=500000
RISK_MAX_SLIPPAGE_BPS=30
TRADER_FEE_BPS=5

STRATEGY_RSI_PERIOD=14
STRATEGY_RSI_INTERVAL=15m
STRATEGY_RSI_CANDLE_COUNT=100
STRATEGY_RSI_OVERSOLD=30
STRATEGY_RSI_OVERBOUGHT=70
STRATEGY_DEFAULT_ORDER_AMOUNT_KRW=5000

TRADER_AUTO_RETRY_ENABLED=true
TRADER_AUTO_RETRY_ATTEMPTS=2
TRADER_AUTO_RETRY_DELAY_MS=1000
TRADER_AUTO_KILL_SWITCH_ENABLED=true
TRADER_AUTO_KILL_SWITCH_FAILURE_THRESHOLD=3
TRADER_AUTO_KILL_SWITCH_WINDOW_SEC=120
TRADER_UNKNOWN_SUBMIT_MAX_AGE_SEC=180
```

## 5. CLI Command Reference (Detailed)

## 5.1 Global behavior
- Use `--json` for machine-safe parsing
- Every command returns an exit code
- Every error JSON includes:
  - `error.message`
  - `error.type`
  - `error.retryable`
  - `error.details`

## 5.2 `status`
```bash
node src/cli/index.js status --json
```
Use it to inspect mode, kill-switch status, open order count, recent risk events.

## 5.3 `health`
```bash
node src/cli/index.js health --json
node src/cli/index.js health --check-exchange --strict --json
```
Options:
- `--check-exchange`: include live public/private API checks
- `--strict`: treat warnings as failures (non-zero exit)

Output:
- `summary.status`: `HEALTHY|DEGRADED|UNHEALTHY`
- `checks[]`: per-check `PASS|WARN|FAIL`

Exit behavior:
- default: `0` if no `FAIL`
- strict: warnings also fail with code `8`
- kill-switch health failure returns code `9`

## 5.4 `markets`
```bash
node src/cli/index.js markets --symbol BTC_KRW --json
```
Public ticker endpoint.

## 5.5 `candles`
```bash
node src/cli/index.js candles --symbol USDT_KRW --interval 1m --count 200 --json
node src/cli/index.js candles --symbol USDT_KRW --interval day --count 30 --json
node src/cli/index.js candles --symbol USDT_KRW --interval week --count 26 --json
node src/cli/index.js candles --symbol USDT_KRW --interval month --count 12 --json
```
Options:
- `--interval`: `1m|3m|5m|10m|15m|30m|60m|240m|day|week|month`
- `--count`: 1~200 (default 200)
- `--to`: optional pivot time

Purpose:
- fetch minute/day/week/month candles
- provide structured inputs for AI strategies

## 5.6 `paper on|off`
```bash
node src/cli/index.js paper on --json
node src/cli/index.js paper off --json
```
Switch simulation/live execution mode.

## 5.7 `order pick`
```bash
node src/cli/index.js order pick --side buy --select-mode momentum --candidates BTC_KRW,ETH_KRW,XRP_KRW --json
```
Options:
- `--side`: currently `buy` only
- `--select-mode`: `momentum` or `volume`
- `--candidates`: comma-separated candidate list

Response highlights:
- `data.symbol`: selected symbol
- `data.ranked`: scored ranking
- `data.metrics`: evidence fields

## 5.8 `strategy run`
```bash
# signal-only run (recommended first step)
node src/cli/index.js strategy run --name rsi --symbol USDT_KRW --dry-run --json

# execution run (paper/live follows current paper mode)
node src/cli/index.js strategy run --name rsi --symbol USDT_KRW --budget 7000 --json
```
Notes:
- currently implemented strategy name is `rsi`
- `--budget` is optional; fallback uses `STRATEGY_DEFAULT_ORDER_AMOUNT_KRW`
- BUY signal places market buy (amount-based KRW order)
- HOLD/SELL signal does not place an order

Response highlights:
- `data.signal.signal`: `BUY|SELL|HOLD`
- `data.rsi.value`: computed RSI
- `data.order`: order payload when BUY is executed

## 5.9 `order place`
```bash
# explicit symbol
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key ord-001 --json

# auto symbol
node src/cli/index.js order place --auto-symbol --side buy --type limit --price 100000 --amount 5000 --client-order-key ord-002 --json
```
Required:
- `--side`
- `--type`
- `--price`
- `--amount`
- one of `--symbol` or `--auto-symbol`

Note:
- quantity (`qty`) is auto-derived internally as `amount / price`.

Strongly recommended:
- always set `--client-order-key`

Live mode notes:
- manual mode requires `--confirm YES`
- OpenClaw mode bypasses confirm

## 5.10 `order unknown` (UNKNOWN_SUBMIT cleanup)
```bash
# single: force-close to CANCELED
node src/cli/index.js order unknown --id <order_id> --action force-close --reason manual-cleanup --json

# single: mark as REJECTED
node src/cli/index.js order unknown --client-order-key <key> --action mark-rejected --json

# batch: resolve all UNKNOWN_SUBMIT locally
node src/cli/index.js order unknown --all --action force-close --reason batch-cleanup --json
```
Purpose:
- explicitly resolve stale local `UNKNOWN_SUBMIT` states.

Notes:
- this command resolves local state only.
- always verify actual exchange status with `reconcile` and account/fill checks.

## 5.11 `order chance/list/get/cancel`
```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
node src/cli/index.js order list --symbol USDT_KRW --state wait --page 1 --limit 100 --order-by desc --json
node src/cli/index.js order list --symbol USDT_KRW --states wait,done --json
node src/cli/index.js order get --id <exchange_uuid_or_local_id> --symbol USDT_KRW --json
node src/cli/index.js order cancel --id <order_id_or_exchange_id> [--symbol USDT_KRW] --json
```
Highlights:
- `order chance`:
  - calls Bithumb private `/v1/orders/chance`
  - use this to inspect market `min_total`, supported order types, and fee/account constraints
- `order list`:
  - calls Bithumb private `/v1/orders` directly
  - supported filters: `--symbol`, `--uuids`, `--state`, `--states`, `--page`, `--limit`, `--order-by`
  - `--state` and `--states` are mutually exclusive
- `order get`:
  - defaults to Bithumb private `/v1/order`
  - if a local ID is provided, the service attempts to recover exchange UUID first
- `order cancel`:
  - when local `exchangeOrderId` is missing, cancel path tries a `clientOrderKey` lookup before cancel
  - if local order does not exist, `--id` can still be used as exchange UUID for direct cancel

## 5.12 `account list`
```bash
node src/cli/index.js account list --json
```
Use it to fetch account balances/locked amounts and persist a `balancesSnapshot`.

## 5.13 `kill-switch`
```bash
node src/cli/index.js kill-switch on --reason emergency --json
node src/cli/index.js kill-switch off --reason resume --json
```

## 5.14 `reconcile` and `logs`
```bash
node src/cli/index.js reconcile run --json
node src/cli/index.js logs tail --json
```
Purpose:
- re-check `UNKNOWN_SUBMIT` orders
- sync account snapshot (`accountSync`)

Additional behavior:
- when `exchangeOrderId` is missing, reconcile attempts fallback lookup by `clientOrderKey` (`identifier`)
- if identifier lookup fails, it attempts a conservative recent-order fingerprint fallback

## 6. Response and Error Contracts

## 6.1 Success sample
```json
{
  "timestamp": "2026-02-13T15:00:00.000Z",
  "command": "order place",
  "status": "ok",
  "code": 0,
  "code_name": "OK",
  "correlation_id": null,
  "data": { "id": "...", "symbol": "BTC_KRW" },
  "error": null
}
```

## 6.2 Error sample
```json
{
  "timestamp": "2026-02-13T15:00:00.000Z",
  "command": "order place",
  "status": "error",
  "code": 3,
  "code_name": "RISK_REJECTED",
  "correlation_id": null,
  "data": null,
  "error": {
    "message": "Risk policy rejected direct order",
    "type": "RISK_REJECTED",
    "retryable": false,
    "details": {
      "reasons": [
        { "rule": "MIN_ORDER_NOTIONAL_KRW", "detail": "1468 < 5000" }
      ]
    }
  }
}
```

## 6.3 Exit codes
| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | success |
| 2 | `INVALID_ARGS` | argument error |
| 3 | `RISK_REJECTED` | blocked by risk policy |
| 5 | `EXCHANGE_RETRYABLE` | transient exchange error |
| 6 | `EXCHANGE_FATAL` | non-retryable exchange error |
| 7 | `RATE_LIMITED` | rate-limit (limited current usage) |
| 8 | `RECONCILE_MISMATCH` | reconciliation mismatch |
| 9 | `KILL_SWITCH_ACTIVE` | blocked by kill-switch |
| 10 | `INTERNAL_ERROR` | internal failure |
| 11 | `FORBIDDEN_IN_AGENT_MODE` | reserved (restrictions currently disabled) |

## 7. AI/OpenClaw Operating Patterns

## 7.1 Standard buy cycle
1. `status --json`
2. `order pick --json`
3. derive order params
4. `order place --auto-symbol ... --client-order-key ... --json`
5. track via `order get` or `order list`

## 7.2 Retry policy
- `code=5` or `code=7`:
  - automatic recovery flow runs (reconcile + state re-check)
  - unresolved repeated failures can trigger auto kill-switch
- `code=2` or `code=3`:
  - adjust parameters/policy first
- `code=6`:
  - inspect exchange message and decide manually

## 7.3 Idempotency key convention
Examples:
- `agent-buy-btc-20260213T1500-001`
- `ai-grid-usdt-20260213-uuid`

Rules:
- include strategy/symbol/time/sequence
- keep the same key across retries

## 8. Operational Checklists

## 8.1 Before startup
- [ ] `.env` keys configured
- [ ] Bithumb allowlist IP configured
- [ ] `status --json` works
- [ ] `markets --symbol BTC_KRW --json` works
- [ ] risk limits reviewed (`RISK_MIN_ORDER_NOTIONAL_KRW` included)

## 8.2 Before live mode
- [ ] paper order/cancel/get flow validated
- [ ] error-code handling implemented in agent
- [ ] kill-switch tested
- [ ] set `TRADER_INITIAL_CAPITAL_KRW` if deterministic daily loss-limit baseline is required

## 8.3 During live trading
- [ ] every order uses `--client-order-key`
- [ ] review `TRADER_AUTO_RETRY_*` parameters
- [ ] review `TRADER_AUTO_KILL_SWITCH_*` parameters
- [ ] inspect and resolve `code=3` before retry
- [ ] when using `--auto-symbol`, review `RISK_AI_*` hard caps

## 8.4 Incident handling
- [ ] `kill-switch on --json`
- [ ] inspect open orders with `order list`
- [ ] cancel if needed
- [ ] resume with `kill-switch off` after root cause is fixed

## 9. Troubleshooting

## 9.1 `not allowed client IP`
Cause:
- API key allowlist missing current public IP

Action:
1. find current public IP
2. add it to Bithumb key allowlist
3. retry

## 9.2 `Missing Bithumb API credentials`
Cause:
- `.env` keys missing/invalid

Action:
1. verify key values in `.env`
2. rerun command

## 9.3 `MIN_ORDER_NOTIONAL_KRW`
Cause:
- `amount` below minimum

Action:
1. increase amount
2. verify `RISK_MIN_ORDER_NOTIONAL_KRW` and `RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL`

## 9.4 `MAX_CONCURRENT_ORDERS`
Cause:
- too many active orders

Action:
1. inspect `order list`
2. cancel stale orders
3. adjust risk limit if needed

## 9.5 `AI_MAX_ORDER_NOTIONAL_KRW` / `AI_MAX_ORDERS_PER_WINDOW` / `AI_MAX_TOTAL_EXPOSURE_KRW`
Cause:
- `--auto-symbol` order exceeded AI hard caps

Action:
1. raise `RISK_AI_MAX_ORDER_NOTIONAL_KRW` or reduce `amount`
2. tune `RISK_AI_MAX_ORDERS_PER_WINDOW` and `RISK_AI_ORDER_COUNT_WINDOW_SEC`
3. tune `RISK_AI_MAX_TOTAL_EXPOSURE_KRW` or reduce existing exposure/open buy orders

## 9.6 `order_not_found`
Cause:
- wrong ID or already terminal order

Action:
1. validate ID from `order list`
2. run `reconcile run`

## 9.7 Daily loss cap seems ignored
Cause:
- baseline capital was not explicitly defined, or account snapshot context is missing

Action:
1. set `TRADER_INITIAL_CAPITAL_KRW` in `.env`
2. run `account list --json` to refresh `balancesSnapshot`
3. retry and inspect risk response details

## 9.8 `STRATEGY_RSI_DATA_INSUFFICIENT`
Cause:
- valid candle count is lower than required (`period + 1`)

Action:
1. increase `STRATEGY_RSI_CANDLE_COUNT`
2. validate symbol/interval with `candles --json`
3. run `strategy run --name rsi --dry-run --json` and inspect RSI payload

## 9.9 RSI strategy does not place BUY orders
Cause:
- current RSI does not satisfy BUY threshold (`RSI <= STRATEGY_RSI_OVERSOLD`)

Action:
1. inspect `data.rsi.value` from dry-run
2. tune `STRATEGY_RSI_OVERSOLD` carefully
3. confirm current paper/live mode before execution run

## 10. Security Practices
- never commit `.env`
- rotate keys regularly
- revoke and reissue keys immediately if exposure is suspected
- mask sensitive fields before sharing logs

## 11. Current Limitations
- limited websocket-based real-time synchronization
- daily PnL guardrail uses equity snapshot estimation (not full ledger accounting)
- built-in strategy set is currently limited (RSI path implemented)
- no built-in long-horizon analytics dashboard (CLI/JSON-first output only)

## 12. Recommended Next Steps
1. strengthen reconciliation for fills/balances
2. automate performance reporting based on fills/PnL
3. improve websocket-driven order/fill sync
4. migrate state backend to PostgreSQL
