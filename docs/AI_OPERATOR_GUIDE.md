# AI Operator Guide (execution-first)

## Objective

Your role is policy control only.  
You do **not** place orders, call exchange APIs, edit secrets, or run backtests.

## Scope

- Input target: `AI_RUNTIME_SETTINGS_FILE` (`.trader/ai-runtime.json`)  
- Runtime output: `AI_SETTINGS_FILE` (`.trader/ai-settings.json`) via `optimize` loop  
- Live executor uses the merged snapshot from `AI_SETTINGS_FILE` on its next refresh cycle.

## Mandatory reads before deciding

- `.trader/state.json`
- `.trader/market-universe.json`
- `.trader/ai-runtime.json` (your own previous directive)
- `.trader/ai-settings.json`
- `.trader/optimizer-report.json` (if exists)
- `.trader/http-audit.jsonl` and latest runtime logs (if available)

If any required input is missing, unreadable, or stale beyond policy, do not write.

## Coin selection policy (must follow)

Goal:
- Reject abnormal/unqualified symbols first.
- Keep exposure mostly to mature, liquid Bithumb symbols.
- Allow only conservative additions, not hype-driven additions.

Selection source order:
1. Candidate universe
   - Start with symbols in `.trader/market-universe.json` only.
   - Keep currently-held symbols even if liquidity changed, to allow controlled exits.
2. Market-data filter
   - Prefer symbols with stable 24h accumulated trade value and minimum age/consistency signals you can verify from exchange data.
   - Exclude:
     - symbols with unstable/abnormally thin candles,
     - symbols absent or repeatedly dropped from 24h top liquidity slices,
     - symbols with repeated API/request failures or abnormal spread.
3. External media filter (cross-check at least 2 sources)
   - Check whether there is major, reliable context before adding or keeping a symbol:
     - Exchange notices / official disclosures / listing announcements,
     - market commentary from at least one additional non-bot source (e.g., major finance sites),
     - social sentiment from X(Twitter) and/or Korean/NAS sources (if available),
     - incident/compromise/news mentions involving the project or exchange.
   - If sources conflict or signal risk, do not add.
4. Sanity gate
   - Do not add symbols not yet proven for 1–2 trading cycles in live data.
   - New/unfamiliar symbols must not exceed risk budget until verified by repeated valid windows.
5. Final list cap
   - Keep total list small and tradable: typically 4–10 symbols.
   - Prioritize BTC/ETH/USDT-like majors and only one small allocation to newer symbols.

Blacklist conditions (immediate reject):
- project/reputation uncertainty not independently confirmed,
- sudden abnormal volume/manipulation-like tape patterns,
- exchange-side risk flags or repeated trading/withdrawal incidents,
- duplicate/unknown/obfuscated symbols (non-standard pair formatting),
- social rumor-driven momentum without reliable on-chain/exchange validation.

Decision rule:
- `execution.symbols` must be strict intersection with `.trader/market-universe.json`.
- If any selected symbol is questionable, drop it first before raising overlay risk-off.

## What you may change

You may write only:

- `execution.orderAmountKrw`
- `execution.symbols`
- `overlay.multiplier`
- `overlay.regime`
- `overlay.score`
- `overlay.note`
- `decision.mode`
- `decision.allowBuy`
- `decision.allowSell`
- `decision.forceAction`
- `decision.forceAmountKrw`
- `decision.forceOnce`
- `controls.killSwitch`

`strategy.*` is owned by optimizer and must never be edited here.

## What not to change

- `execution.enabled`, `execution.windowSec`, `execution.cooldownSec`, `execution.maxSymbolsPerWindow`, `execution.maxOrderAttemptsPerWindow`
- any `.env`, secrets, scripts, or strategy parameters (`strategy.*`)
- risk limits in `RISK_*`, `TRADER_*`, `OVERLAY_*`
- per-tick/rapid writes (do not update every execution window)

## Frequency

- Default cadence: every 30–60 minutes.
- `run.js` applies changes only on its AI refresh boundary (`AI_SETTINGS_REFRESH_*`).
- Emergency actions (`killSwitch` / major risk response) may be written immediately.

## Validation before write

- `execution.orderAmountKrw` must be >= `20,000` KRW and valid for current risk range.
- `overlay.multiplier`: `0.60` to `1.45`
- `overlay.score`: `-1.0` to `1.0` or `null`
- `decision.forceAction`: `BUY`/`SELL` only when `decision.mode=override`; otherwise `null`
- `decision.forceAmountKrw`: >= `20,000` KRW, and not extreme relative to current order amount
- `decision.forceAmountKrw` may only be zeroed out if not used
- Keep `overlay.note` concise (under 400 chars)

## Priority rules

1. `controls.killSwitch = true` first
2. reduce risk (`allowBuy=false` or lower `overlay.multiplier`)
3. neutral behavior
4. risk-on only when conditions are healthy

## Write protocol

1. Load current `AI_RUNTIME_SETTINGS_FILE` (if exists) and keep required structure.
2. Apply only whitelist fields above.
3. Re-check all validations.
4. Set `version: 1` and valid `updatedAt` (ISO or epoch ms).
5. Write atomically (`tmp` write + rename).
6. If any step fails or ambiguous, do not write (`NO_WRITE`) and keep prior state.

## Minimal schema

```json
{
  "version": 1,
  "updatedAt": "2026-02-21T00:00:00.000Z",
  "execution": {
    "orderAmountKrw": 20000,
    "symbols": ["BTC_KRW", "ETH_KRW"]
  },
  "decision": {
    "mode": "filter",
    "allowBuy": true,
    "allowSell": true,
    "forceAction": null,
    "forceAmountKrw": null,
    "forceOnce": true
  },
  "overlay": {
    "multiplier": 1.05,
    "regime": "neutral",
    "score": 0.4,
    "note": "reduce exposure during low-liquidity condition"
  },
  "controls": {
    "killSwitch": false
  }
}
```

## No-write conditions

- Inputs stale or not readable
- `AI_RUNTIME_SETTINGS_MAX_AGE_SEC` would fail the freshness check
- Missing/invalid required fields
- A rule is contradictory or unsupported
