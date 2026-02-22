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

## 실행

- 실행형 서비스: `npm start`
- 기본 다중 종목은 `.env`의 `EXECUTION_SYMBOLS=BTC_KRW,ETH_KRW,...` 로 지정 가능합니다.
- 실행 중 유동성/품질 필터를 통과한 종목 목록이 `.trader/market-universe.json`에 저장됩니다.

## AI 설정 연동(자동매매 설정 입력점)

- 기본 입력 파일: `.trader/ai-runtime.json` (AI가 작성)
- 실행 반영 파일: `.trader/ai-settings.json` (optimize 출력)
- 실행 루프는 AI 스냅샷 갱신 주기(기본 30~60분, `AI_SETTINGS_REFRESH_MIN_SEC=1800`, `AI_SETTINGS_REFRESH_MAX_SEC=3600`)로 동작합니다.
- AI 설정 변경은 `run.js`에서 다음 AI refresh 시점에만 반영됩니다(체결 루프 1틱마다 즉시 반영되지 않음).
- AI의 상세 제어 규칙은 `docs/AI_OPERATOR_GUIDE.md` v1.3을 준수합니다.
- `AI_SETTINGS_REQUIRE_OPTIMIZER_APPROVAL=true`면 `optimize`가 스탬프한 스냅샷만 실제 거래에 반영됩니다.
- `npm run optimize`는 AI 지시 파일(`.trader/ai-runtime.json`)의 `execution.symbols`가 있으면 최적화 대상 심볼로 사용합니다.
- 동시 다중 종목 실행은 `execution.symbols` 배열(또는 콤마 문자열)로 지정합니다.
- 요청 종목은 `.trader/market-universe.json`과 교집합으로 실행됩니다(저유동/이상 종목 자동 제외).
- 필터 강도는 `.env`의 `MARKET_UNIVERSE_*` 값으로 조정합니다.
- 권장 운용: AI는 30~60분 주기로 시장 점검 후 변경 필요 시에만 `ai-runtime.json` 갱신
- 권장 필수 체크 입력: `.trader/state.json`, `.trader/market-universe.json`, `.trader/http-audit.jsonl`(활성 시), 런타임 로그, `.trader/optimizer-report.json`(있을 때).

예시:

```json
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "symbol": "USDT_KRW",
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
        "forceAmountKrw": 20000
      }
    }
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

AI 입력 파일 포맷 규칙:

- `AI_RUNTIME_SETTINGS_FILE`은 원자적 쓰기(`tmp` 파일 작성 후 `rename`)로 갱신해야 합니다.
- `updatedAt`(`ISO` 또는 epoch ms)와 `version`(`1`)을 반드시 포함합니다.
- `AI_RUNTIME_SETTINGS_MAX_AGE_SEC`를 설정하면 만료된 지시를 자동 무시합니다.
- `strategy.*`는 `optimize` 담당이며 AI가 직접 작성하면 안 됩니다.

## 실행 명령

```bash
npm start
```

CLI 모드는 제거되었습니다. 설정/제어는 `.env`와 `AI_RUNTIME_SETTINGS_FILE`(`.trader/ai-runtime.json`) 기반으로 수행합니다.

## 실행 규칙

- BUY 시그널: 즉시 시장가 매수 실행
- SELL 시그널: `STRATEGY_AUTO_SELL_ENABLED=true`면 즉시 시장가 매도 실행
- `STRATEGY_SELL_ALL_ON_EXIT=true`면 SELL은 고정 KRW 금액이 아니라 보유 가능한 수량 기준 전량 매도로 계산
- AI 판단 정책:
  - `decision.mode=filter`: AI가 BUY/SELL 허용 여부를 제어 (`allowBuy`, `allowSell`)
  - `decision.mode=override`: AI가 윈도우당 강제 액션 가능 (`forceAction`, `forceAmountKrw`)
  - 종목별 정책은 `decision.symbols.<SYMBOL>` 로 개별 오버라이드 가능
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

## HTTP 감사로그

- 활성화: `TRADER_HTTP_AUDIT_ENABLED`
- 파일 경로: `TRADER_HTTP_AUDIT_FILE` (기본 `.trader/http-audit.jsonl`)
- 자동 로테이션: `TRADER_HTTP_AUDIT_MAX_BYTES`, `TRADER_HTTP_AUDIT_PRUNE_RATIO`, `TRADER_HTTP_AUDIT_CHECK_EVERY`

상태 파일 과대화 방지 보존 상한:

- `TRADER_STATE_KEEP_LATEST_ONLY` (`true`면 최신 스냅샷 + 미체결 주문 중심으로만 유지)
- `TRADER_RETENTION_CLOSED_ORDERS`
- `TRADER_RETENTION_ORDERS`
- `TRADER_RETENTION_ORDER_EVENTS`
- `TRADER_RETENTION_STRATEGY_RUNS`
- `TRADER_RETENTION_BALANCE_SNAPSHOTS`
- `TRADER_RETENTION_FILLS`

일 손실 기준값:

- `TRADER_INITIAL_CAPITAL_KRW` 설정 시 해당 값을 baseline으로 사용
- 미설정 시 당일 첫 평가자산을 baseline으로 사용

## 참고

- 실거래는 빗썸 키 + 허용 IP 설정이 필요합니다.
- 빗썸 초당 제한(공개 150, 비공개 140)은 내장 제한기로 반영됩니다.
- WebSocket 연결 제한(기본 5/s)은 `BITHUMB_WS_CONNECT_MAX_PER_SEC`로 적용됩니다.
