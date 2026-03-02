# TICKET 01 — Liquidation Mode (killSwitch 2단계 전환)

## 목표
`killSwitch=true` 즉시 거래중단으로 보유 청산이 막히는 문제를 해결한다.

- 1단계: **청산 단계** (liquidation mode)
  - `killSwitch=false`
  - `decision.mode=override`
  - `decision.forceAction=SELL`
  - `decision.allowBuy=false`
  - `decision.allowSell=true`
- 2단계: 보유 정리 확인 후에만 `killSwitch=true`

## 수정 대상
- `src/app/run.js`
- `src/core/trading-system.js`
- `src/app/ai-settings.js`

## 구현 요약
1. `ai-runtime/ai-settings`에 liquidation 상태를 판별할 수 있는 헬퍼 추가
2. `run.js`에서 killSwitch 적용 우선순위를 다음처럼 조정
   - 보유자산 > 0 && liquidation 지시 존재 => killSwitch 적용 보류(거래 계속)
   - 보유자산 ≈ 0 => killSwitch 적용
3. `trading-system.js`에서 override SELL이 들어오면 BUY 신호를 무시하고 SELL 우선 실행
4. 보유자산 정리 판정(예: BTC/ETH 각각 notional < 최소주문금액) 로직 추가

## 상세 체크리스트
- [ ] liquidation active 판별 함수 추가 (`isLiquidationActive(policy, balances)`)
- [ ] killSwitch 적용 전 보유잔고 체크 추가
- [ ] `KILL_SWITCH_ACTIVE`로 SELL까지 막히지 않도록 분기 정리
- [ ] 청산 완료 시 `state.system.liquidationCompletedAt` 기록
- [ ] 상태 전이 로그 추가
  - `liquidation mode started`
  - `liquidation mode progress`
  - `liquidation mode completed -> kill switch engaged`

## 수용 기준 (Acceptance)
- liquidation 시작 후 BUY 주문이 발생하지 않는다.
- 보유자산이 남아있는 동안 SELL 주문 시도는 지속된다.
- 보유자산이 기준치 이하로 내려가면 killSwitch=true 전환된다.
- PM2 로그에서 단계 전이가 확인된다.

## 테스트 시나리오
1. BTC/ETH 소량 보유 상태에서 liquidation 정책 적용
2. 2~3 execution window 내 SELL 시도 확인
3. 보유 정리 후 killSwitch 활성화 확인
4. 재시작 후 상태 일관성 확인
