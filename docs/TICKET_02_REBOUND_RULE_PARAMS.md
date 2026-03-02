# TICKET 02 — 반등 진입/청산 룰 파라미터

## 목표
약세장에서도 "아무것도 안 하는 상태"를 줄이고, 반등 구간에서 기계적 분할 진입/청산 수행.

## 제안 파라미터 (초안)

### A. 진입 조건 (Rebound Entry)
- 급락 인식: 최근 N봉 하락률 <= `-2.5%` (기본 N=8, 15m)
- 반등 확인: 현재가가 `EMA(9)` 상향 돌파 + 직전 고점 1회 돌파
- 유동성 필터: 최근 24h 거래대금 상위 구간(시장 유니버스 필터 통과)

### B. 분할 진입
- 1차: 기본 주문금액의 40%
- 2차: +0.8% 추가 상승 확인 시 30%
- 3차: +1.6% 추가 상승 확인 시 30%

### C. 청산/리스크
- 손절: 평균단가 대비 `-4.8%`
- 1차 익절: `+2.2%`에서 50%
- 2차 익절: `+3.8%`에서 30%
- 잔여 20%: 트레일링 스탑 `-1.2%`

### D. 리스크오프에서도 허용할 범위
- `overlay.regime=risk_off`에서도
  - `allowBuy=true` 가능 (단 multiplier <= 0.90)
  - `orderAmountKrw=20000` 고정 유지

## 수정 대상
- `src/engine/strategy-optimizer.js` (후보 파라미터 포함)
- `src/core/trading-system.js` (분할 집행/익절/트레일링)
- `.env` 또는 defaults (`src/config/defaults.js`)에 파라미터 키 추가

## 권장 env 키
- `REBOUND_DROP_LOOKBACK=8`
- `REBOUND_DROP_PCT=-2.5`
- `REBOUND_CONFIRM_EMA=9`
- `REBOUND_ENTRY_SPLITS=0.4,0.3,0.3`
- `REBOUND_STOP_LOSS_PCT=4.8`
- `REBOUND_TP1_PCT=2.2`
- `REBOUND_TP2_PCT=3.8`
- `REBOUND_TRAIL_PCT=1.2`

## 수용 기준
- 반등 조건 미충족 시 BUY 미집행
- 반등 조건 충족 시 분할 BUY 실행
- 손절/익절/트레일링이 자동으로 동작
- 24h 리포트에서 매매 횟수/승률/손익 확인 가능
