# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the live trading daemon
npm test           # Run all tests (node --test)
npm run lint       # Lint with ESLint

# Run a single test file
node --test test/signal-engine.test.js

# Run tests matching a pattern
node --test --test-name-pattern="momentum" test/signal-engine.test.js
```

## Architecture

**Execution-first, rule-based crypto trading system for Bithumb (Korean exchange).**

Core execution path: `MarketData → SignalEngine → RiskEngine → ExecutionEngine`

**AI role:** Periodic policy supervisor only — AI writes settings/overlay files every 30-60 min. There is NO per-tick AI inference.

### Key Layers

**`src/app/run.js`** — Main daemon loop. Refreshes AI settings and market universe on schedule, then executes per-symbol strategy windows. All other `src/app/` files are supporting utilities (optimizer, audit report, smoke tests).

**`src/core/`** — Core orchestration:
- `trading-system.js` — Initializes all engines, manages strategy runtime, state persistence, account preflight
- `store.js` — File-based state persistence with locking and retention policies
- `market-universe.js` — Filters symbols by liquidity/min trade value from `.trader/market-universe.json`

**`src/engine/`** — Strategy logic:
- `signal-engine.js` — Generates momentum/breakout signals. Momentum = `(close[t] - close[t-lookback]) / close[t-lookback]`
- `risk-engine.js` — Position sizing with volatility targeting, max exposure/order constraints, overlay multiplier application
- `execution-engine.js` — Places buy/sell orders, tracks order state
- `overlay-engine.js` — Loads AI multiplier cache from `.trader/overlay.json` with staleness guards

**`src/exchange/`** — Bithumb integration:
- `bithumb-client.js` — REST API client (JWT auth, exponential backoff retries)
- `bithumb-public-ws.js` — WebSocket client for real-time tickers/orderbook
- `rate-limiter.js` — Per-second sliding window rate limiter (separate queues for public/private APIs)

**`src/config/defaults.js`** — All environment variable parsing. Config groups: Exchange, Runtime, Strategy, Risk, AI Bridge, Market Universe, Overlay, Execution, Optimizer.

### Runtime State (`.trader/` directory)

Generated at runtime, not committed:
- `state.json` — Latest execution state
- `ai-settings.json` — AI supervisor policy settings
- `market-universe.json` — Curated tradable symbols
- `overlay.json` — AI multiplier cache
- `http-audit.jsonl` — HTTP audit trail (optional)

### Important Constraints

- **Live-only execution** — paper mode was removed. Missing API keys (`BITHUMB_API_KEY`, `BITHUMB_API_SECRET`) cause startup failure.
- **ES modules** (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- **Node ≥ 20** required.
- **Test framework** is Node.js built-in `node:test` with `node:assert/strict` — no Jest/Mocha.
- **Default strategy** is `risk_managed_momentum` (configurable via `STRATEGY_NAME` env var).
