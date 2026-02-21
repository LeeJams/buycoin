# AI Operator Guide (v1.1)

Purpose: Give AI unambiguous, machine-actionable rules to control the system as a **top-level policy layer only**.

## 1) Mandatory architecture rules (must follow)

1. `src/app/run.js` = live execution engine.
2. `src/app/optimize.js` = optimization engine.
3. AI writes only to `AI_SETTINGS_FILE` (`.trader/ai-settings.json`).
4. AI must **not** call APIs, place orders, or run backtests directly.
5. If AI is ambiguous: `NO_WRITE`.

## 2) Required files read before every write decision

Before editing, AI must inspect at minimum:
- `.trader/state.json`
- `.trader/http-audit.jsonl` (last 500 lines or last 1 hour)
- runtime logs from `npm start` (last 1 hour)
- `.trader/ai-settings.json` (current snapshot)
- `.trader/optimizer-report.json` (if exists)

Decision is **invalid** if any required file is unreadable for 1 cycle.

## 3) Decision cadence

- Normal schedule: every 30~60 minutes.
- Emergency override: immediate write only if emergency condition is met.
- One symbol-level control change per run unless explicitly required; avoid oscillating multipliers.

## 4) Allowed editable fields (hard whitelist)

AI may edit only these fields:
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
- `execution.orderAmountKrw`
- `execution.symbols` (optional, only for emergency rotation)

AI MUST NOT edit:
- any `strategy.*` field
- `execution.windowSec`, `execution.cooldownSec`, `execution.enabled`
- any risk limits in config
- credentials, secrets, `.env`, scripts, code.

## 5) Numeric hard limits (must validate before write)

- `overlay.multiplier`: `0.60 ~ 1.45`  
- `execution.orderAmountKrw`: change limit `±10%` from current value per write, and final value must be `>= 20,000` KRW
- `decision.forceAmountKrw`: if present, must be `>= 20,000` KRW and `<= current execution.orderAmountKrw * 10`
- `overlay.score`: `-1.0 ~ 1.0` or `null`
- `overlay.note`: max 400 characters

Violation = reject write.

## 6) Regime mapping (deterministic)

- `risk_off`
  - `overlay.multiplier`: `0.60 ~ 0.85`
  - `decision.mode`: `filter`
  - `decision.allowBuy`: `false` (except existing positions)
  - `decision.allowSell`: `true`
- `neutral`
  - `overlay.multiplier`: `0.90 ~ 1.10`
  - `decision.mode`: `filter`
  - `decision.allowBuy`: `true`
  - `decision.allowSell`: `true`
- `risk_on`
  - `overlay.multiplier`: `1.00 ~ 1.30`
  - `decision.mode`: `filter`
  - `decision.allowBuy`: `true`
  - `decision.allowSell`: `true`

If `controls.killSwitch=true`, all other fields are advisory only; system safety dominates.

## 7) Risk-off / Kill-switch conditions (priority order)

AI must apply in priority:
1. **Kill switch emergency**
   - repeated API failures
   - sustained order rejections
   - invalid market data anomalies
   - rule: set `controls.killSwitch=true`, `decision.allowBuy=false`, `decision.allowSell=true`
2. **Risk-off**
3. **Neutral**
4. **Risk-on**

Never use `decision.forceAction` unless explicitly required as emergency and justified in note.

## 8) Decision rubric (objective checks)

- Risk-off signal if any of:
  - realized slippage spike above configured tolerance
  - 3+ consecutive failed fills
  - cash drawdown acceleration for last cycle
  - API latency + error burst in audit
- Risk-on signal if:
  - stable fills
  - no KPI deterioration
  - no repeated reject/timeout burst
- If both signals present, choose lower risk state.

## 9) Mandatory write protocol (exact sequence)

1. Load current `.trader/ai-settings.json`.
2. Apply only whitelist fields.
3. Preserve all unknown/untouched fields.
4. Re-validate strict JSON and all numeric limits.
5. Append reason with timestamp in `overlay.note`.
6. Write atomically: temp file + rename.
7. If any step fails: abort and keep previous file.

No best-effort write allowed.

## 10) Required output schema

```json
{
  "version": 1,
  "updatedAt": "2026-02-21T00:00:00.000Z",
  "execution": { "orderAmountKrw": 20000 },
  "strategy": {},
  "decision": {
    "mode": "filter",
    "allowBuy": true,
    "allowSell": true,
    "forceAction": null,
    "forceAmountKrw": null,
    "forceOnce": true
  },
  "overlay": {
    "multiplier": 1.00,
    "regime": "neutral",
    "score": 0.50,
    "note": "risk_off: 3 consecutive fill failures, reduce exposure"
  },
  "controls": {
    "killSwitch": false
  }
}
```

- If only partial patch is allowed by your runtime, write merged full file.

## 11) Hard stop rules (non-negotiable)

- If uncertain: `NO_WRITE`.
- If any required input is stale > 30 minutes: `NO_WRITE`, hold neutral / reduce risk.
- If one signal conflicts with another: choose lower risk.
- If output is outside limits: `NO_WRITE`.
- If force action unsupported: `forceAction = null`.
