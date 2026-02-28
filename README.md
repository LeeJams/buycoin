# buycoin-trader

실거래 전용 Bithumb 자동매매 시스템입니다.  
현재 운영 방식은 **Execution-First**이며, AI는 주문 타이밍을 직접 실행하지 않고 **정책/설정 감독자**로 동작합니다.

---

## 1) 현재 아키텍처

실행 경로(고정):

`MarketData -> SignalEngine -> RiskEngine -> ExecutionEngine`

AI 역할:
- `.trader/ai-runtime.json`에 정책 입력
- `npm run optimize`가 정책을 검증/병합해 `.trader/ai-settings.json` 생성
- 런타임(`npm start`)이 `ai-settings` 스냅샷을 주기적으로 반영

핵심 원칙:
- 틱 단위 AI 추론으로 주문하지 않음
- 주문 실행은 규칙 기반으로 결정
- 위험 제어가 수익 최적화보다 우선

---

## 2) 현재 운영 모드

- 런타임: **live-only** (`npm start`)
- 실행 프로세스: PM2 상시 실행 권장
- 설정 반영: 파일 기반 (`.trader/ai-runtime.json` → `optimize` → `.trader/ai-settings.json`)
- 시장 유니버스: `.trader/market-universe.json` 기반 필터 적용

현재 기본 운용 프로파일(품질 우선):
- symbols: `BTC_KRW`, `XRP_KRW` 중심 (상황에 따라 4심볼 프로파일 사용)
- `maxSymbolsPerWindow`: 2~4
- `maxOrderAttemptsPerWindow`: 1~2
- `orderAmountKrw`: 동적(현금 기준) 또는 20,000 고정

---

## 3) 현재 리스크/안정화 정책

### A. 보호청산/재진입
- 보호청산 후 동일 심볼 BUY 재진입 쿨다운 적용 (`postExitBuyCooldownSec`, 기본 900초)

### B. Dust 처리
- `holdingNotional < 5,000 KRW`(dust)는 보호청산/신호 대상에서 제외

### C. 비실행성 거절 승격 제외
다음 거절은 `riskReject streak`/auto kill-switch 승격에서 제외:
- `MIN_ORDER_NOTIONAL_KRW`
- `INSUFFICIENT_CASH`
- `SELL_EXCEEDS_HOLDING`
- `NO_SELLABLE_HOLDING`
- `KILL_SWITCH_ACTIVE`(에코)

### D. SELL 최소금액 미만 스킵
- SELL 주문금액이 최소 체결금액 미만이면 주문 시도 자체를 스킵

### E. BUY 현금 사전 게이트
- BUY 주문 전 가용 KRW를 선검사하여 현금 부족 주문 시도 차단

---

## 4) KPI/보고

현재 보고는 `npm run kpi-report` 기준으로 생성합니다.

보고 항목:
1. attempted / successful / rejected / fills
2. 성공률·거절률
3. reject reason Top3(rule)
4. 기준손익(`operator-baseline.json` 기준 baseline/equity/pnl)
5. 포지션 변화

기준손익 파일:
- `.trader/operator-baseline.json`

---

## 5) 주요 파일

- `.trader/ai-runtime.json` : AI 정책 입력
- `.trader/ai-settings.json` : optimize 병합 결과(런타임 반영 대상)
- `.trader/state.json` : 런타임 상태/주문/이벤트
- `.trader/market-universe.json` : 거래 가능 심볼 스냅샷
- `.trader/execution-kpi-summary.json` : KPI 요약
- `.trader/operator-baseline.json` : 기준손익 baseline

---

## 6) 실행 방법

### 설치
```bash
npm install
```

### 런타임 실행
```bash
npm start
```

### 최적화/정책 병합
```bash
npm run optimize
```

### KPI 보고 생성
```bash
npm run kpi-report
```

### PM2 운영 예시
```bash
pm2 start npm --name buycoin -- start
pm2 restart buycoin
pm2 logs buycoin
pm2 status
```

---

## 7) 환경 요구사항

- Node.js 20+
- Bithumb API Key/Secret
- `.env` 설정 필수 (`BITHUMB_*`, `TRADER_*`, `RISK_*`, `AI_SETTINGS_*` 등)

---

## 8) 운영 주의사항

- `npm start`는 상시 데몬으로 운영하고, cron에는 `optimize`/운영 점검 작업만 배치
- settings 반영은 파일 스냅샷/refresh 주기 기반이므로 즉시 반영이 필요한 경우 optimize + 재시작 검증 수행
- 이상 징후(성공률 급락/거절률 급등/정책-로그 불일치) 시 즉시 핫픽스 후 재검증

---

## 9) 테스트

```bash
npm run lint
npm test
```
