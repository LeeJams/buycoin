# buycoin-trader 사용 가이드 (KO)

## 아키텍처

정통 실행 파이프라인:

1. 시세 데이터 수집
2. 룰 기반 시그널 생성(리스크-관리 모멘텀, 기본)
3. 리스크 검증
4. 즉시 주문 실행

AI/ML은 포지션 배율(overlay cache) 용도로만 사용합니다.
AI/ML이 실시간 트리거/체결 타이밍을 결정하지 않습니다.

## 설치

```bash
cd ./buycoin
npm install
```

`.env.example`를 기준으로 `.env`를 설정하세요.

## 실행 모드

- 안전 제약 기반 최적화 + 적용: `npm run optimize`
- 실행형 서비스(기본): `npm start`
- 단발 실행 점검: `npm run start:once`
- 엔드포인트 스모크 점검(조회 전용): `npm run smoke`
- 엔드포인트 스모크 점검(주문+취소): `npm run smoke:write`
- HTTP 감사로그 요약 리포트: `npm run audit:report`
- 페이퍼 모드 기본 초기자금: `1,000,000 KRW` (`TRADER_PAPER_INITIAL_CASH_KRW`로 변경 가능)

## AI 설정 연동(자동매매 설정 입력점)

- 기본 파일: `.trader/ai-settings.json`
- 실행 루프는 매 윈도우 시작 시 이 파일을 읽습니다.
- AI는 이 파일만 갱신하면 종목/주문금액/윈도우/쿨다운/드라이런/킬스위치를 제어할 수 있습니다.

예시:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "enabled": true,
    "symbol": "USDT_KRW",
    "orderAmountKrw": 7000,
    "windowSec": 180,
    "cooldownSec": 20,
    "dryRun": false
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
    "baseOrderAmountKrw": 7000
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

## 실행 명령

```bash
npm run optimize
npm start
npm run start:once
npm run smoke
npm run smoke:write
npm run audit:report
```

CLI 모드는 제거되었습니다. 설정/제어는 `.env`와 `AI_SETTINGS_FILE`로 수행합니다.

## 안전+수익 최적화 동작

`npm run optimize`는 아래를 수행합니다.

1. `OPTIMIZER_SYMBOLS` 종목 캔들 조회
2. 모멘텀 파라미터 그리드 탐색
3. 안전 제약 필터 통과 후보만 우선 선택
   - 최대 낙폭, 최소 거래수, 최소 승률, 최소 Profit Factor, 최소 수익률
4. 결과 저장
   - 리포트: `OPTIMIZER_REPORT_FILE` (기본 `.trader/optimizer-report.json`)
   - 적용 파일: `AI_SETTINGS_FILE` (`execution.symbol`, `strategy.*`)

실행 중 자동 재탐색(1시간 주기):

- `OPTIMIZER_REOPT_ENABLED=true`
- `OPTIMIZER_REOPT_INTERVAL_SEC=3600`

서비스 시작 시 자동 실행하려면:

```bash
OPTIMIZER_APPLY_ON_START=true npm start
```

## 실행 규칙

- BUY 시그널: `--dry-run`이 아니면 즉시 시장가 매수 실행
- SELL 시그널: `STRATEGY_AUTO_SELL_ENABLED=true`면 즉시 시장가 매도 실행
- HOLD 시그널: 주문하지 않음
- 오버레이는 수량이 아니라 주문금액 배율만 조정
  - `조정금액 = 기본금액 * (시그널 리스크배율) * (AI 오버레이 배율)`
- 오버레이가 지연/만료되면 fallback multiplier 사용
- 실시간 티커 모드는 빗썸 Public WebSocket(`wss://ws-api.bithumb.com/websocket/v1`)을 사용
- WebSocket 채널 지원:
  - public: `ticker`, `trade`, `orderbook`
  - private: `myOrder`, `myAsset`

## 리스크 제어

- 최소/최대 주문금액
- 최대 동시 오픈주문 수
- 최대 총 노출
- 일 손실 한도
- Kill Switch

## Write 스모크 가드

`npm run smoke:write`는 아래 조건이 모두 맞을 때만 주문/취소 검증을 수행합니다.

- `SMOKE_ENABLE_WRITES=true`
- `SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND`
- `TRADER_PAPER_MODE=false`

Write 스모크 순서:

1. `orders/chance`로 최소 주문금액 조회
2. 깊은 지정가 매수 주문
3. 주문 취소
4. 취소 후 주문 상태 재조회

## HTTP 감사로그

- 활성화: `TRADER_HTTP_AUDIT_ENABLED`
- 파일 경로: `TRADER_HTTP_AUDIT_FILE` (기본 `.trader/http-audit.jsonl`)
- 집계 리포트: `npm run audit:report`

일 손실 기준값:

- `TRADER_INITIAL_CAPITAL_KRW` 설정 시 해당 값을 baseline으로 사용
- 미설정 시 당일 첫 평가자산을 baseline으로 사용

## 참고

- 실거래는 빗썸 키 + 허용 IP 설정이 필요합니다.
- 빗썸 초당 제한(공개 150, 비공개 140)은 내장 제한기로 반영됩니다.
- WebSocket 연결 제한(기본 5/s)은 `BITHUMB_WS_CONNECT_MAX_PER_SEC`로 적용됩니다.
