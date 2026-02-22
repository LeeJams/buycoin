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
- Removed paper/simulation runtime path (`TRADER_PAPER_MODE`, `TRADER_PAPER_INITIAL_CASH_KRW`)
- Runtime is live-only with mandatory startup account preflight
- Default storage profile is reduced-growth (`TRADER_STATE_KEEP_LATEST_ONLY=true`, `TRADER_HTTP_AUDIT_ENABLED=false`)

## Breaking Change (Live-Only)

- Paper mode is removed from runtime behavior and env contract.
- `npm start` always runs live execution path.
- If API keys are missing or account preflight fails, process exits before execution loop.
- There is no CLI command mode; operation is daemon + file-driven settings (`.env`, `.trader/ai-runtime.json`, `.trader/ai-settings.json`).

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
- AI bridge: `AI_RUNTIME_SETTINGS_FILE` (AI directives input), `AI_SETTINGS_*` (runtime snapshot output)
- Market universe: `MARKET_UNIVERSE_*` (liquidity/quality filtered tradable symbols)
- Overlay: `OVERLAY_*` (AI/ML cache settings)

Unsupported/removed vars:

- `TRADER_PAPER_MODE`
- `TRADER_PAPER_INITIAL_CASH_KRW`

## Quick Start

### 1) Configure `.env`

- Copy `.env.example` to `.env`.
- Fill `BITHUMB_ACCESS_KEY` and `BITHUMB_SECRET_KEY`.
- Review risk/execution defaults before first run (`RISK_*`, `EXECUTION_*`).

### 2) Run as execution service (daemon, live)

```bash
npm start
```

The service uses `EXECUTION_*` values from `.env` and runs realtime windows continuously.
When enabled, it refreshes AI runtime settings snapshot from `.trader/ai-settings.json` periodically.
Default refresh cadence is 30-60 minutes (`AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`).
AI directives are written to `.trader/ai-runtime.json` by external AI process; `optimize` reads this file and merges only execution/decision/overlay/controls directives into `ai-settings.json`. `strategy` is always optimizer-owned.
It also refreshes a curated KRW market universe snapshot in `.trader/market-universe.json`.
Symbols outside this universe are automatically filtered out from `execution.symbols`.
You can set multi-symbol runtime defaults with `EXECUTION_SYMBOLS=BTC_KRW,ETH_KRW,USDT_KRW`.
Default runtime logging is activity-first:
- detailed `execution window completed` logs only when orders were attempted
- idle windows emit heartbeat logs every `EXECUTION_LOG_HEARTBEAT_WINDOWS` windows (default `12`)

### 3) Verify runtime health quickly

Look for these startup logs:

- `live preflight passed`: account/auth check succeeded
- `execution service started`: loop is active
- `strategy updated from ai settings` / `overlay updated from ai settings`: AI snapshot applied

### 4) 운영 한 장 정리 (필수)

#### 운영 1페이지 템플릿

- `npm start`는 실시간 거래 데몬으로 상시 실행(`pm2`/`systemd` 운영)
- `npm run optimize`는 외부 스케줄러(권장 cron)로 실행
- AI/설정 반영은 `run.js`의 AI refresh 주기에서만 반영, `optimize` 실행 즉시 반영 아님
- `npm run optimize`는 AI 지시 파일(`.trader/ai-runtime.json`)의 `execution.symbols`가 있으면 그 심볼들을 최적화 대상으로 사용
- `TRADER_STATE_KPI_HISTORY_MAX_ENTRIES`와 `TRADER_STATE_KPI_HISTORY_SHARD_DAYS`로 상태 KPI 메타만 남김

권장 운영 흐름:
1. `npm start`를 `pm2` 또는 `systemd`로 24/7 가동
2. `cron`으로 `npm run optimize`를 주기 실행
3. AI는 `AI_SETTINGS_REFRESH_MIN_SEC`/`AI_SETTINGS_REFRESH_MAX_SEC` 또는 `AI_SETTINGS_REFRESH_FIXED_SEC`로 반영 주기 조정
4. `AI_SETTINGS_APPLY_COOLDOWN_SEC`로 급격한 설정 변경 억제
5. `AI_SETTINGS_REQUIRE_OPTIMIZER_APPROVAL=true`면 `optimize` 결과를 스탬프 받은 스냅샷만 실행 적용
6. 상태 KPI가 비정상적으로 커지면 `TRADER_STATE_KPI_HISTORY_MAX_ENTRIES`, `TRADER_STATE_KPI_HISTORY_SHARD_DAYS`를 축소

`npm run optimize` cron 템플릿(2시간 간격 예시):

```bash
0 */2 * * * cd /path/to/buycoin && /usr/bin/env npm run optimize >> /var/log/buycoin-optimize.log 2>&1
```

```text
주의: `npm start`를 cron에 넣지 마세요.
주의: cron은 1회 시작/중단 용도가 아니라 외부 배치 실행용입니다.
```

운영 가드:
- `OPTIMIZER_LOCK_FILE`: `.trader/optimize.lock`
- `OPTIMIZER_LOCK_TTL_SEC`: `900`
- 락이 남아 있으면 다음 `optimize`는 즉시 스킵(중복 실행 방지)
- 최적화 결과는 `.trader/ai-runtime.json` 기반으로 `.trader/ai-settings.json`에 쓰여지며, 데몬은 다음 AI refresh 시점에 반영

Window summary interpretation:

- `buySignals` / `sellSignals`: strategy signal count
- `attemptedOrders`: order submissions attempted
- `successfulOrders`: exchange accepted orders

## Live Runtime

- Runtime is configured for live trading operation.
- Startup performs account preflight (`/v1/accounts`) before entering execution loop.

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

Set by external process (AI agent, batch job, research model) in `AI_RUNTIME_SETTINGS_FILE` (`.trader/ai-runtime.json`).

Execution reads overlay with timeout guard:

- If overlay is late/stale, fallback multiplier is used
- Execution never waits indefinitely for AI

## AI Runtime Settings File

External AI writes `AI_RUNTIME_SETTINGS_FILE` (default: `.trader/ai-runtime.json`).
`npm run optimize` merges only execution/decision/overlay/controls directives into `AI_SETTINGS_FILE` (`.trader/ai-settings.json`) each run. `strategy` fields in runtime input are ignored on merge.
The daemon loads this merged snapshot and refreshes it periodically.
Default refresh range is 30-60 minutes (`AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`).
For concurrent multi-symbol execution, set `execution.symbols` (array or comma-separated string).
The runtime intersects requested symbols with `.trader/market-universe.json` and only executes allowed ones.

Default schema (AI directive format):

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "symbol": "BTC_KRW",
    "symbols": ["BTC_KRW", "ETH_KRW", "USDT_KRW"],
    "orderAmountKrw": 20000
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
        "forceAmountKrw": 20000,
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

AI runtime input safety (atomic + freshness):

- `AI_RUNTIME_SETTINGS_FILE` must be written by atomic replace (`tmp` write + `rename`) to avoid partial reads.
- If your AI process writes this file, include:
  - `updatedAt` (ISO datetime or epoch ms)
  - `version: 1`
- In .env, set `AI_RUNTIME_SETTINGS_MAX_AGE_SEC` to reject stale runtime directives.
- `AI_RUNTIME_SETTINGS_FILE` must contain only:
  - `version`, `updatedAt`
  - `execution`, `decision`, `overlay`, `controls`
- `strategy.*` is optimizer-owned and **never writable** by AI.

Notes:

- AI settings changes are applied on the next AI snapshot refresh cycle (default 30-60 minutes), not per tick.
- Recommended AI update cadence is every 30-60 minutes.
- If no strategy/policy change is needed, keep the same `ai-settings.json` values.
- `strategy.*` updates are applied by `optimize` only (signal engine is rebuilt safely).
- Refresh cadence is configurable with `AI_SETTINGS_REFRESH_MIN_SEC` / `AI_SETTINGS_REFRESH_MAX_SEC`.
- `decision.mode`:
  - `rule`/`filter`: execute only signal-based actions (with AI allow/deny filters)
  - `override`: allow AI-forced action (`BUY`/`SELL`) for the window
- Execution path remains deterministic (`MarketData -> Signal -> Risk -> Execution`).
- In live mode, startup includes account preflight (`account list`) to verify your credentials/account access.

## AI Operator Contract (for OpenClaw/LLM)

This section is the canonical contract for an AI that manages runtime behavior.
For strict machine-action rules, also use `docs/AI_OPERATOR_GUIDE.md` (v1.3).

### Role

AI acts as a **strategy/policy supervisor**, not as a per-tick execution engine.

### Cadence

- Run market/account review every 30-60 minutes.
- If no meaningful change is needed, keep the existing `ai-settings.json` as-is.
- Emergency updates (for example kill switch) can be written immediately.

### Read Inputs (AI side)

- `.env` for hard limits and runtime configuration
- `.trader/state.json` for latest balances/holdings/open orders/system state
- `.trader/market-universe.json` for tradable symbol universe
- `.trader/optimizer-report.json` for latest optimization candidate context (if exists)
- `.trader/http-audit.jsonl` for API failures, rate-limit pressure, and latency
- process logs (stdout/stderr) for runtime health

### Write Output (AI side)

- Target file: `.trader/ai-runtime.json` only
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
| `decision.mode` | `filter` (default), `rule`, or `override` |
| `decision.forceAction` | Use only with `override`; value `BUY` or `SELL` |
| `decision.forceOnce` | Keep `true` for one-shot forced action |
| `overlay.multiplier` | Positive multiplier; final size is still bounded by risk engine |
| `controls.killSwitch` | `true` means immediate trading halt behavior |

`strategy` is optimizer-owned and must not be updated through `AI_RUNTIME_SETTINGS_FILE`.

### Propagation Timing

- AI updates are not applied per tick.
- New settings are applied on next AI snapshot refresh cycle (default 30-60 minutes).
- Refresh range is controlled by:
- `AI_SETTINGS_REFRESH_MIN_SEC`
- `AI_SETTINGS_REFRESH_MAX_SEC`
- `AI_SETTINGS_REQUIRE_OPTIMIZER_APPROVAL` (default false): if true, only apply AI snapshots with optimizer stamp
- `AI_SETTINGS_REFRESH_FIXED_SEC` (override fixed period, disables jitter)
- `AI_SETTINGS_APPLY_COOLDOWN_SEC` (minimum interval between runtime applications)

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
5. Decide whether to write
   - if no material change, do not write file
   - material change examples:
     - `execution.symbols` changed
     - `execution.orderAmountKrw` changed by >= 10%
     - `overlay.multiplier` changed by >= 0.05
     - `decision.*` changed
     - `controls.killSwitch` changed
6. Write output safely
   - update only `.trader/ai-runtime.json`
   - keep `version=1`
   - set `updatedAt` to current UTC ISO timestamp
   - write with atomic replace (`tmp` file then rename)
7. Self-validate after write
   - file is valid JSON
   - every symbol format is `BASE_KRW`
   - `execution.symbols` is a subset of `.trader/market-universe.json`
   - `execution.orderAmountKrw` respects risk/env limits
   - if `decision.allowBuy=false`, confirm it is intentional and add a meaningful `note` explaining why

### AI No-Do Rules

- Do not edit `.env` during normal operation.
- Do not write orders directly; only write policy/settings snapshot.
- Do not use symbols outside `.trader/market-universe.json` unless explicitly force-included by env.
- Do not disable sells globally while holdings exist, unless kill switch policy requires full freeze.
- Do NOT use `decision.allowBuy=false` as a substitute for normal risk throttle. `allowBuy=false` is a hard block for genuine emergencies (technical issues, extreme market events). For bearish markets, lower `overlay.multiplier` and tighten risk posture instead.
- Do NOT set `momentumEntryBps` above 30. Values like 100–300 bps do not mean "be cautious" — they mean "never enter". If the intent is to avoid buying, use `allowBuy=false` with a clear `note`.
- Do NOT set `volatilityLookback` below 48 or `momentumLookback` below 12. Short lookbacks produce noisy, unreliable signals.
- Do NOT use both `allowBuy=false` AND `momentumEntryBps > 30` simultaneously. This creates a redundant double-block that makes it easy to forget one is still active when the other is cleared.

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
- Paper mode is intentionally removed (live-only runtime).
- Runtime control is file-driven (`.env` + `AI_RUNTIME_SETTINGS_FILE` + `AI_SETTINGS_FILE`).
- Runtime observability is log-driven (JSON logs to stdout/stderr).
- Runtime state is persisted in `TRADER_STATE_FILE` (default `.trader/state.json`).
- State collections are retention-capped (see `TRADER_RETENTION_*`).
- Default is `TRADER_STATE_KEEP_LATEST_ONLY=true` to keep only latest snapshots + open orders (+ a small closed-order tail).

## WebSocket Coverage

Implemented channels (`bithumb/socket.md`):

- Public: `ticker`, `trade`, `orderbook`
- Private: `myOrder`, `myAsset`

Default endpoints:

- Public: `BITHUMB_WS_PUBLIC_URL=wss://ws-api.bithumb.com/websocket/v1`
- Private: `BITHUMB_WS_PRIVATE_URL=wss://ws-api.bithumb.com/websocket/v1/private`

Private streams use JWT header auth (`authorization: Bearer ...`) and documented error frames are surfaced as runtime errors.

## Bithumb Rate Limit Compliance

The runtime is tuned to Bithumb official limits by default:

- Public API: `BITHUMB_PUBLIC_MAX_PER_SEC=150`
- Private API: `BITHUMB_PRIVATE_MAX_PER_SEC=140`
- WebSocket connect throttle: `BITHUMB_WS_CONNECT_MAX_PER_SEC=5`

Behavior:

- HTTP requests pass through internal rate limiter queues
- Retryable failures use exponential backoff
- Order path remains protected from burst overshoot

If needed, lower these values in `.env` for extra safety. Avoid setting values above exchange policy.

## HTTP Audit Log

Each exchange HTTP call is logged to JSONL audit trail:

- enable/disable: `TRADER_HTTP_AUDIT_ENABLED`
- file path: `TRADER_HTTP_AUDIT_FILE` (default `.trader/http-audit.jsonl`)
- auto rotation: `TRADER_HTTP_AUDIT_MAX_BYTES`, `TRADER_HTTP_AUDIT_PRUNE_RATIO`, `TRADER_HTTP_AUDIT_CHECK_EVERY`
- default is disabled (`TRADER_HTTP_AUDIT_ENABLED=false`) to reduce file growth in 24/7 runs

## Execution Log Volume Control

- `EXECUTION_LOG_ONLY_ON_ACTIVITY` (default `true`)
  - `true`: print full window log only when order activity exists
  - `false`: print full window log every window
- `EXECUTION_LOG_HEARTBEAT_WINDOWS` (default `12`)
  - when activity-only logging is on, emit one heartbeat summary every N windows

## Runtime Files (`.trader`)

Generated/used files:

- `.trader/ai-runtime.json`: external AI selector/context input file
- `.trader/ai-settings.json`: AI runtime snapshot merged by optimize (main control output)
- `.trader/state.json`: latest runtime state (balances snapshots, order/fill/event tails, system status)
- `.trader/market-universe.json`: filtered tradable symbol set
- `.trader/overlay.json`: local overlay cache store
- `.trader/http-audit.jsonl`: optional HTTP audit trail (only when enabled)

Growth controls:

- `TRADER_STATE_KEEP_LATEST_ONLY=true` keeps only latest snapshots + open orders + short closed-order tail
- `TRADER_RETENTION_*` caps each state collection
- `TRADER_STATE_KPI_HISTORY_MAX_ENTRIES` caps `state.system.executionKpiHistory` (요약 KPI 메타 최근 N개)
- `TRADER_STATE_KPI_HISTORY_SHARD_DAYS` limits KPI 메타 샤드(일자) 보존 범위
- `TRADER_HTTP_AUDIT_ENABLED=false` by default to avoid large JSONL growth in 24/7 runs

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
