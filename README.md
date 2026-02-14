# buycoin-trader

CLI-first trading system for the Bithumb API with OpenClaw orchestration.

- No web dashboard.
- All operations are executed via CLI.
- Human-readable and machine-readable output are both supported (`--json`).

Detailed guides:
- Korean (full): `./USAGE_KO.md`
- Korean (beginner): `./GUIDE_KO_BEGINNER.md`
- English (full): `./USAGE_EN.md`

## What This System Does
| Area | What it does | Main commands |
|---|---|---|
| Runtime status | Shows current mode, kill-switch state, open order count, recent events | `status`, `health` |
| Market data | Fetches ticker and candles (minute/day/week/month) | `markets`, `candles` |
| Orderability check | Checks exchange constraints including `min_total` before live orders | `order chance` |
| Order execution | Places amount-based orders (`amount` in KRW, quantity derived internally) | `order place` |
| Order tracking | Lists and fetches order details, supports cancel | `order list`, `order get`, `order cancel` |
| AI symbol selection | Picks symbols from candidate universe by ranking | `order pick`, `order place --auto-symbol` |
| Strategy execution | Runs strategy logic and can place real/paper orders | `strategy run --name rsi` |
| Risk enforcement | Blocks unsafe orders via hard risk rules | built into `order place` |
| Recovery | Reconciles `UNKNOWN_SUBMIT`, missing exchange UUIDs, and stale local state | `reconcile run`, `order unknown` |
| Agent audit | Records agent-executed CLI actions in local state | `agentAudit` |

## Order Flow (Live)
1. Build order input from CLI options.
2. Call `order chance` to fetch exchange-side minimum notional.
3. Run risk evaluation.
4. Submit order to exchange.
5. Save order as `ACCEPTED` or `UNKNOWN_SUBMIT` on uncertain failure.
6. Recover with `reconcile run` if needed.

## Risk and Safety Controls
| Control | Description | Default | Environment variable |
|---|---|---|---|
| Min order notional | Lower bound for order notional | `5000` | `RISK_MIN_ORDER_NOTIONAL_KRW` |
| Symbol min override | Per-symbol minimum notional override | empty | `RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL` |
| Max order notional | Upper bound per order | `300000` | `RISK_MAX_ORDER_NOTIONAL_KRW` |
| Max concurrent open orders | Limits simultaneously open orders | `5` | `RISK_MAX_CONCURRENT_ORDERS` |
| Daily loss limit | Stops new risk if daily realized loss threshold is exceeded | `500000` | `RISK_DAILY_LOSS_LIMIT_KRW` |
| Initial capital baseline | Optional baseline for daily PnL calculation in live mode | empty | `TRADER_INITIAL_CAPITAL_KRW` |
| AI max order notional | Applies only to `--auto-symbol` orders | `100000` | `RISK_AI_MAX_ORDER_NOTIONAL_KRW` |
| AI max orders per window | Order count cap for auto-symbol mode | `3` | `RISK_AI_MAX_ORDERS_PER_WINDOW` |
| AI order-count window | Counting window in seconds | `60` | `RISK_AI_ORDER_COUNT_WINDOW_SEC` |
| AI max total exposure | Exposure cap for AI buy orders | `500000` | `RISK_AI_MAX_TOTAL_EXPOSURE_KRW` |
| Kill switch | Blocks new orders and attempts open-order cleanup | off | `kill-switch on/off` |

## Daily PnL Baseline (Live Orders)
This is the key fix for the "daily loss limit not applied" issue.

Behavior:
1. Before each live order, the system builds risk context from private account data.
2. It estimates current KRW equity from:
   - KRW balance (`balance + locked`)
   - non-KRW holdings valued by `avgBuyPrice` when `unitCurrency=KRW`
3. It decides baseline by trade date (`TZ`, default `Asia/Seoul`):
   - if `TRADER_INITIAL_CAPITAL_KRW` is set and valid, baseline = this value
   - otherwise baseline = first observed equity of the day
4. It computes:
   - `dailyRealizedPnlKrw = currentEquityKrw - baselineEquityKrw`
5. If account fetch fails, it falls back to latest stored balance snapshot.
6. Risk rule `RISK_DAILY_LOSS_LIMIT_KRW` is then applied with this computed PnL.

Where it is stored:
- `state.settings.dailyPnlBaseline`
- `state.balancesSnapshot[]` (recent snapshots, capped)

Important notes:
- Paper mode does not use exchange equity for this context.
- If you want deterministic daily-loss behavior from startup, set `TRADER_INITIAL_CAPITAL_KRW`.

## RSI Strategy (Implemented)
`rsi` strategy is fully wired into `strategy run`.

Command:
```bash
npm start -- strategy run --name rsi --symbol USDT_KRW --dry-run --json
```

Execution rules:
1. Fetch candles with configured interval/count.
2. Compute RSI (Wilder smoothing).
3. Evaluate signal using oversold/overbought thresholds.
4. If `--dry-run`, return signal only.
5. If live/paper execution and signal is `BUY`, submit market buy with KRW amount.
6. If signal is `HOLD` or `SELL`, no order is submitted.

RSI strategy config:
| Variable | Default | Description |
|---|---|---|
| `STRATEGY_RSI_PERIOD` | `14` | RSI period |
| `STRATEGY_RSI_INTERVAL` | `15m` | Candle interval (`1m...240m`, `day`, `week`, `month`) |
| `STRATEGY_RSI_CANDLE_COUNT` | `100` | Requested candle count (auto-adjusted to at least `period+1`) |
| `STRATEGY_RSI_OVERSOLD` | `30` | BUY threshold (RSI <= oversold) |
| `STRATEGY_RSI_OVERBOUGHT` | `70` | SELL threshold (RSI >= overbought) |
| `STRATEGY_DEFAULT_ORDER_AMOUNT_KRW` | `5000` | Fallback order amount when budget is omitted |

## Troubleshooting for Recent Issues
| Symptom | Meaning | Action |
|---|---|---|
| Daily loss cap seems ignored | No deterministic baseline was available | Set `TRADER_INITIAL_CAPITAL_KRW` and verify `status --json` + live `order place --json` responses |
| `STRATEGY_RSI_DATA_INSUFFICIENT` | Not enough valid candles for configured period | Increase `STRATEGY_RSI_CANDLE_COUNT`, check symbol/interval availability |
| RSI strategy never buys | Signal is not `BUY` under thresholds | Use `--dry-run --json` first and inspect `data.rsi.value` with thresholds |

## OpenClaw Mode
Enable:
```bash
OPENCLAW_AGENT=true
```

Behavior:
- OpenClaw can execute CLI commands directly.
- Commands are logged to `agentAudit`.
- Manual confirmation (`--confirm YES`) is bypassed in agent mode.

## Requirements
- Node.js 20+

## Installation
```bash
npm install
```

## Required `.env`
```env
BITHUMB_ACCESS_KEY=...
BITHUMB_SECRET_KEY=...
```

## Common Runtime Configuration
```env
# Exchange request caps
BITHUMB_PUBLIC_MAX_PER_SEC=150
BITHUMB_PRIVATE_MAX_PER_SEC=140

# Runtime mode
TRADER_PAPER_MODE=true
TRADER_DEFAULT_SYMBOL=BTC_KRW
OPENCLAW_AGENT=true

# AI symbol universe
TRADER_AUTO_SELECT_MODE=momentum
TRADER_AUTO_SELECT_CANDIDATES=BTC_KRW,ETH_KRW,XRP_KRW,SOL_KRW,DOGE_KRW

# Optional daily-loss baseline
TRADER_INITIAL_CAPITAL_KRW=

# RSI strategy
STRATEGY_RSI_PERIOD=14
STRATEGY_RSI_INTERVAL=15m
STRATEGY_RSI_CANDLE_COUNT=100
STRATEGY_RSI_OVERSOLD=30
STRATEGY_RSI_OVERBOUGHT=70
STRATEGY_DEFAULT_ORDER_AMOUNT_KRW=5000
```

## Quick Start
```bash
npm start -- status --json
npm start -- health --check-exchange --json
npm start -- order chance --symbol USDT_KRW --json
npm start -- order pick --side buy --select-mode momentum --json
npm start -- strategy run --name rsi --symbol USDT_KRW --dry-run --json
npm start -- order place --auto-symbol --side buy --type limit --price 100000 --amount 5000 --client-order-key ai-001 --json
```

Manual live order (non-agent mode):
```bash
npm start -- order place --symbol USDT_KRW --side buy --type limit --price 1467 --amount 5000 --client-order-key live-001 --confirm YES --json
```

## Command Guide
| Command | Purpose | Key output fields |
|---|---|---|
| `trader status --json` | Runtime snapshot | `settings`, `openOrders` |
| `trader health --check-exchange --json` | Runtime + exchange readiness checks | `summary`, `checks[]` |
| `trader markets --symbol BTC_KRW --json` | Single-symbol ticker | ticker payload |
| `trader candles --symbol USDT_KRW --interval 1m --count 30 --json` | Historical candles | candle array |
| `trader order chance --symbol USDT_KRW --json` | Exchange orderability/minimum check | `market.bid.min_total`, `market.ask.min_total` |
| `trader strategy run --name rsi --symbol USDT_KRW --dry-run --json` | Run RSI strategy and return signal | `data.signal`, `data.rsi`, `data.order` |
| `trader order pick --side buy --json` | AI symbol ranking and selection | `data.symbol`, `data.ranked` |
| `trader order place ... --amount ... --json` | Place order | order state or risk rejection reasons |
| `trader order list --symbol USDT_KRW --json` | List orders | order list |
| `trader order get --id ... --json` | Fetch one order | local/exchange order detail |
| `trader order cancel --id ... --json` | Cancel order | cancellation result |
| `trader reconcile run --json` | Recover state mismatches | reconcile summary |
| `trader order unknown ... --json` | Resolve stale `UNKNOWN_SUBMIT` locally | cleanup summary |
| `trader account list --json` | Fetch balances and snapshot state | normalized account list |
| `trader kill-switch on --reason ... --json` | Emergency stop | switch state |

## Exit Codes
- `0`: success
- `2`: invalid args
- `3`: risk rejected
- `5`: exchange retryable
- `6`: exchange fatal
- `7`: rate-limited
- `8`: reconcile mismatch
- `9`: kill-switch active
- `10`: internal error

## State and Persistence
- Runtime state file: `.trader/state.json`
- Includes orders, order events, fills, account snapshots, risk events, agent audit, and health history.
- Stores daily PnL baseline at `settings.dailyPnlBaseline`.
- Stores account snapshots from:
  - `account list` command
  - live-order risk context build
- Keeps recent balance snapshots (rolling cap) to support fallback when private account fetch fails.
- Reconcile can backfill missing exchange UUIDs and resolve uncertain submission states.

## Testing
```bash
npm run lint
npm test
```

## Security Notes
- Never print or commit API keys.
- Keep secrets in `.env` or external secret manager.
- Start in paper mode.
- Always run `order chance` before live trading.
