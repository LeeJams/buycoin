# buycoin-trader 운영 가이드 (한국어, 상세판)

문서 버전: `2026-02-14`
대상 코드 경로: `./` (프로젝트 루트)

## 0. 문서 목적

이 문서는 `buycoin-trader`를 다음 목적에 맞춰 실제로 운용하기 위한 상세 가이드입니다.

1. 사람 운영자가 직접 CLI를 사용해 거래하는 경우
2. OpenClaw 같은 에이전트가 CLI를 호출해 자동 운용하는 경우

이 문서는 현재 구현된 기능만 다룹니다. 구현되지 않은 기능은 “제한사항”에 별도 표기합니다.

## 1. 빠른 시작 (5분)

### 1.1 설치

```bash
cd ./buycoin
npm install
```

### 1.2 `.env` 입력

파일: `./.env`

필수 키:

```env
BITHUMB_ACCESS_KEY=여기에_액세스키
BITHUMB_SECRET_KEY=여기에_시크릿키
```

### 1.3 기본 점검

```bash
node src/cli/index.js status --json
node src/cli/index.js health --json
node src/cli/index.js markets --symbol BTC_KRW --json
node src/cli/index.js order chance --symbol BTC_KRW --json
node src/cli/index.js strategy run --name rsi --symbol BTC_KRW --dry-run --json
```

### 1.4 페이퍼 주문 테스트

```bash
node src/cli/index.js paper on --json
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key quickstart-001 --json
```

### 1.5 실거래 전환

```bash
node src/cli/index.js paper off --json
```

수동 모드(`OPENCLAW_AGENT=false`) 실거래 주문 예:

```bash
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key live-001 --confirm YES --json
```

OpenClaw 모드(`OPENCLAW_AGENT=true`)에서는 `--confirm YES` 없이 실행됩니다.

## 2. 핵심 개념

### 2.1 모드

- `paper mode`:
  - 거래소로 주문을 보내지 않음
  - 로컬 상태 파일에만 주문 상태 반영
- `live mode`:
  - 거래소 Private API 호출
  - 실제 주문/취소 발생

### 2.2 상태 저장

- 기본 상태 파일: `.trader/state.json`
- 주요 저장 데이터:
  - settings (paper/kill-switch)
  - orders/orderEvents/fills
  - balancesSnapshot
  - dailyPnlBaseline
  - riskEvents
  - agentAudit
- 동시성 보호:
  - `.lock` 파일 기반 락으로 동시 쓰기 충돌 방지

### 2.3 주문 멱등성(Idempotency)

- 옵션: `--client-order-key`
- 같은 키로 재시도하면 기존 주문을 반환
- AI 자동 재시도 시 필수 권장

### 2.4 최소주문금액 사전 차단

- 리스크 규칙: `RISK_MIN_ORDER_NOTIONAL_KRW`
- 기본값: `5000`
- 계산식: `price * (amount / price)` = `amount`
- 예: `amount=1468` 이면 주문 전 `RISK_REJECTED`
- 라이브 주문(`paper off`)에서는 주문 직전 `/v1/orders/chance`를 조회해
  - 매수: `market.bid.min_total`
  - 매도: `market.ask.min_total`
    를 동적으로 적용합니다.
- 최종 최소주문금액은 `max(설정 최소값, 거래소 최소값)`으로 계산됩니다.

### 2.5 일 손실 제한용 PnL 기준값

- 라이브 주문 직전, 리스크 컨텍스트를 만들기 위해 계좌 스냅샷을 조회합니다.
- 현재 KRW 평가금액은 아래로 추정합니다.
  - KRW 현금: `balance + locked`
  - 비KRW 자산: `unitCurrency=KRW`인 경우 `avgBuyPrice` 기반 평가
- 일자별 기준값(baseline) 결정:
  - `TRADER_INITIAL_CAPITAL_KRW`가 유효하면 그 값을 사용
  - 없으면 당일 첫 평가금액을 사용
- 계산식: `dailyRealizedPnlKrw = currentEquityKrw - baselineEquityKrw`
- 계좌 조회 실패 시 최근 `balancesSnapshot`을 fallback으로 사용합니다.

### 2.6 RSI 전략 실행

- 전략 이름: `rsi`
- 실행 명령: `strategy run --name rsi`
- 시그널 규칙:
  - RSI <= oversold 이면 `BUY`
  - RSI >= overbought 이면 `SELL`
  - 그 외는 `HOLD`
- 주문 규칙:
  - `--dry-run`: 시그널만 반환, 주문 없음
  - 일반 실행: `BUY` 시그널일 때만 시장가 매수 실행

## 3. 디렉토리 구조

```text
.
├─ .env
├─ .env.example
├─ README.md
├─ USAGE_KO.md
├─ USAGE_EN.md
├─ src
│  ├─ cli/index.js
│  ├─ config/*
│  ├─ core/*
│  ├─ exchange/*
│  └─ lib/*
└─ test/*
```

## 4. 환경변수 상세 레퍼런스

### 4.1 인증/거래소

| 변수                          | 필수      | 기본값                    | 설명                          |
| ----------------------------- | --------- | ------------------------- | ----------------------------- |
| `BITHUMB_ACCESS_KEY`          | O(실거래) | `""`                      | 빗썸 Access Key               |
| `BITHUMB_SECRET_KEY`          | O(실거래) | `""`                      | 빗썸 Secret Key               |
| `BITHUMB_BASE_URL`            | X         | `https://api.bithumb.com` | REST API 베이스 URL           |
| `BITHUMB_TIMEOUT_MS`          | X         | `5000`                    | HTTP 타임아웃(ms)             |
| `BITHUMB_MAX_RETRIES`         | X         | `4`                       | 재시도 최대 횟수              |
| `BITHUMB_RETRY_BASE_MS`       | X         | `250`                     | 재시도 백오프 기준(ms)        |
| `BITHUMB_PUBLIC_MAX_PER_SEC`  | X         | `150`                     | Public API 초당 최대 요청 수  |
| `BITHUMB_PRIVATE_MAX_PER_SEC` | X         | `140`                     | Private API 초당 최대 요청 수 |

### 4.2 런타임

| 변수                         | 필수 | 기본값               | 설명                                    |
| ---------------------------- | ---- | -------------------- | --------------------------------------- |
| `TRADER_PAPER_MODE`          | X    | `true`               | 시작 시 페이퍼 모드                     |
| `TRADER_STATE_FILE`          | X    | `.trader/state.json` | 상태 파일 경로                          |
| `TRADER_STATE_LOCK_STALE_MS` | X    | `30000`              | 재시작 후 stale lock 자동 회수 기준(ms) |
| `TRADER_STARTUP_RECONCILE`   | X    | `true`               | 시작 시 `UNKNOWN_SUBMIT` 자동 리컨실    |
| `TRADER_DEFAULT_SYMBOL`      | X    | `BTC_KRW`            | 기본 심볼                               |
| `OPENCLAW_AGENT`             | X    | `false`              | 에이전트 모드 활성화                    |
| `TRADER_ENV_FILE`            | X    | `.env`               | 다른 env 파일 경로 사용 시 지정         |

### 4.3 AI 종목 선택

| 변수                            | 필수 | 기본값                                     | 설명                     |
| ------------------------------- | ---- | ------------------------------------------ | ------------------------ |
| `TRADER_AUTO_SELECT_MODE`       | X    | `momentum`                                 | `momentum` 또는 `volume` |
| `TRADER_AUTO_SELECT_CANDIDATES` | X    | `BTC_KRW,ETH_KRW,XRP_KRW,SOL_KRW,DOGE_KRW` | 자동 선택 후보군         |

### 4.4 리스크

| 변수                                | 필수 | 기본값   | 설명                                                         |
| ----------------------------------- | ---- | -------- | ------------------------------------------------------------ |
| `RISK_MAX_CONCURRENT_ORDERS`        | X    | `5`      | 동시 활성 주문 수 제한                                       |
| `RISK_MIN_ORDER_NOTIONAL_KRW`       | X    | `5000`   | 최소 주문금액(KRW)                                           |
| `RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL` | X    | `""`     | 종목별 최소 주문금액 override (`USDT_KRW:1000,BTC_KRW:7000`) |
| `RISK_MAX_ORDER_NOTIONAL_KRW`       | X    | `300000` | 최대 주문금액(KRW)                                           |
| `RISK_DAILY_LOSS_LIMIT_KRW`         | X    | `500000` | 일 손실 한도(KRW)                                            |
| `TRADER_INITIAL_CAPITAL_KRW`        | X    | `""`     | 일 PnL 기준자본(선택)                                        |
| `RISK_AI_MAX_ORDER_NOTIONAL_KRW`    | X    | `100000` | `--auto-symbol` 주문 1회 최대 주문금액                       |
| `RISK_AI_MAX_ORDERS_PER_WINDOW`     | X    | `3`      | 시간창 내 AI 주문 최대 횟수                                  |
| `RISK_AI_ORDER_COUNT_WINDOW_SEC`    | X    | `60`     | AI 주문 횟수 집계 시간창(초)                                 |
| `RISK_AI_MAX_TOTAL_EXPOSURE_KRW`    | X    | `500000` | AI 매수 주문 기준 총 노출 상한(예상)                         |
| `RISK_MAX_SLIPPAGE_BPS`             | X    | `30`     | (예약) 슬리피지 제한                                         |
| `TRADER_FEE_BPS`                    | X    | `5`      | (예약) 수수료 가정                                           |

### 4.5 전략(RSI)

| 변수                                | 필수 | 기본값 | 설명                            |
| ----------------------------------- | ---- | ------ | ------------------------------- |
| `STRATEGY_RSI_PERIOD`               | X    | `14`   | RSI 기간                        |
| `STRATEGY_RSI_INTERVAL`             | X    | `15m`  | 캔들 간격                       |
| `STRATEGY_RSI_CANDLE_COUNT`         | X    | `100`  | 캔들 조회 개수(최소 `period+1`) |
| `STRATEGY_RSI_OVERSOLD`             | X    | `30`   | BUY 임계값                      |
| `STRATEGY_RSI_OVERBOUGHT`           | X    | `70`   | SELL 임계값                     |
| `STRATEGY_DEFAULT_ORDER_AMOUNT_KRW` | X    | `5000` | 전략 budget 미지정 시 주문금액  |

### 4.6 복원력(재시도/자동 킬스위치)

| 변수                                        | 필수 | 기본값 | 설명                                |
| ------------------------------------------- | ---- | ------ | ----------------------------------- |
| `TRADER_AUTO_RETRY_ENABLED`                 | X    | `true` | `code=5/7` 자동 처리 활성화         |
| `TRADER_AUTO_RETRY_ATTEMPTS`                | X    | `2`    | 자동 재처리 횟수                    |
| `TRADER_AUTO_RETRY_DELAY_MS`                | X    | `1000` | 자동 재처리 간격(ms)                |
| `TRADER_AUTO_KILL_SWITCH_ENABLED`           | X    | `true` | 반복 실패 시 자동 킬스위치          |
| `TRADER_AUTO_KILL_SWITCH_FAILURE_THRESHOLD` | X    | `3`    | 윈도우 내 실패 누적 임계값          |
| `TRADER_AUTO_KILL_SWITCH_WINDOW_SEC`        | X    | `120`  | 실패 집계 시간창(초)                |
| `TRADER_UNKNOWN_SUBMIT_MAX_AGE_SEC`         | X    | `180`  | 장기 `UNKNOWN_SUBMIT` 보호 기준(초) |

### 4.7 예시 `.env`

```env
BITHUMB_ACCESS_KEY=...
BITHUMB_SECRET_KEY=...
BITHUMB_PUBLIC_MAX_PER_SEC=150
BITHUMB_PRIVATE_MAX_PER_SEC=140

TRADER_PAPER_MODE=true
TRADER_DEFAULT_SYMBOL=BTC_KRW
TRADER_STATE_FILE=.trader/state.json
TRADER_STATE_LOCK_STALE_MS=30000
TRADER_STARTUP_RECONCILE=true
OPENCLAW_AGENT=true

TRADER_AUTO_SELECT_MODE=momentum
TRADER_AUTO_SELECT_CANDIDATES=BTC_KRW,ETH_KRW,XRP_KRW,SOL_KRW,DOGE_KRW

RISK_MAX_CONCURRENT_ORDERS=5
RISK_MIN_ORDER_NOTIONAL_KRW=5000
RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL=USDT_KRW:1000,BTC_KRW:7000
RISK_MAX_ORDER_NOTIONAL_KRW=300000
RISK_DAILY_LOSS_LIMIT_KRW=500000
TRADER_INITIAL_CAPITAL_KRW=
RISK_AI_MAX_ORDER_NOTIONAL_KRW=100000
RISK_AI_MAX_ORDERS_PER_WINDOW=3
RISK_AI_ORDER_COUNT_WINDOW_SEC=60
RISK_AI_MAX_TOTAL_EXPOSURE_KRW=500000
RISK_MAX_SLIPPAGE_BPS=30
TRADER_FEE_BPS=5

STRATEGY_RSI_PERIOD=14
STRATEGY_RSI_INTERVAL=15m
STRATEGY_RSI_CANDLE_COUNT=100
STRATEGY_RSI_OVERSOLD=30
STRATEGY_RSI_OVERBOUGHT=70
STRATEGY_DEFAULT_ORDER_AMOUNT_KRW=5000

TRADER_AUTO_RETRY_ENABLED=true
TRADER_AUTO_RETRY_ATTEMPTS=2
TRADER_AUTO_RETRY_DELAY_MS=1000
TRADER_AUTO_KILL_SWITCH_ENABLED=true
TRADER_AUTO_KILL_SWITCH_FAILURE_THRESHOLD=3
TRADER_AUTO_KILL_SWITCH_WINDOW_SEC=120
TRADER_UNKNOWN_SUBMIT_MAX_AGE_SEC=180
```

## 5. CLI 명령어 상세

## 5.1 공통 규칙

- `--json` 사용 권장 (AI 파싱 안정성)
- 모든 응답은 exit code를 가짐
- 실패 응답 JSON은 공통으로 아래 필드를 가짐
  - `error.message`
  - `error.type`
  - `error.retryable`
  - `error.details`

## 5.2 `status`

```bash
node src/cli/index.js status --json
```

용도:

- 현재 모드(paper/live), kill-switch, open orders, 최근 리스크 이벤트 확인

## 5.3 `health`

```bash
node src/cli/index.js health --json
node src/cli/index.js health --check-exchange --strict --json
```

옵션:

- `--check-exchange`: 퍼블릭/프라이빗 API 실제 호출 포함
- `--strict`: 경고(`WARN`)도 실패로 간주해 non-zero 종료

출력:

- `summary.status`: `HEALTHY|DEGRADED|UNHEALTHY`
- `checks[]`: 항목별 `PASS|WARN|FAIL`

종료코드:

- 기본: `FAIL` 없으면 `0`
- `--strict`: `WARN`만 있어도 실패(`8`)
- kill-switch 활성 상태 실패는 `9`

## 5.4 `markets`

```bash
node src/cli/index.js markets --symbol BTC_KRW --json
```

용도:

- 퍼블릭 시세 조회

## 5.5 `candles`

```bash
node src/cli/index.js candles --symbol USDT_KRW --interval 1m --count 200 --json
node src/cli/index.js candles --symbol USDT_KRW --interval day --count 30 --json
node src/cli/index.js candles --symbol USDT_KRW --interval week --count 26 --json
node src/cli/index.js candles --symbol USDT_KRW --interval month --count 12 --json
```

옵션:

- `--interval`: `1m|3m|5m|10m|15m|30m|60m|240m|day|week|month`
- `--count`: 1~200 (기본 200)
- `--to`: 기준 시각(선택)

용도:

- 분/일/주/월 캔들 조회
- AI 전략 입력 데이터 확보

## 5.6 `paper on|off`

```bash
node src/cli/index.js paper on --json
node src/cli/index.js paper off --json
```

용도:

- 거래 실행 모드 전환

## 5.7 `order pick` (AI 종목 선택)

```bash
node src/cli/index.js order pick --side buy --select-mode momentum --candidates BTC_KRW,ETH_KRW,XRP_KRW --json
```

옵션:

- `--side`: 현재 `buy`만 지원
- `--select-mode`: `momentum` 또는 `volume`
- `--candidates`: 쉼표 구분 후보

응답 핵심:

- `data.symbol`: 선택된 심볼
- `data.ranked`: 후보 점수 순위
- `data.metrics`: 선택 근거 수치

## 5.8 `strategy run`

```bash
# 시그널만 확인 (권장)
node src/cli/index.js strategy run --name rsi --symbol USDT_KRW --dry-run --json

# 실행 모드 (paper/live는 현재 모드에 따름)
node src/cli/index.js strategy run --name rsi --symbol USDT_KRW --budget 7000 --json
```

주의:

- 현재 구현 전략 이름은 `rsi`입니다.
- `--budget`을 생략하면 `STRATEGY_DEFAULT_ORDER_AMOUNT_KRW`를 사용합니다.
- BUY 시그널이면 시장가 매수(금액 기반)를 실행합니다.
- HOLD/SELL이면 주문을 생성하지 않습니다.

응답 핵심:

- `data.signal.signal`: `BUY|SELL|HOLD`
- `data.rsi.value`: 계산된 RSI
- `data.order`: BUY 실행 시 주문 정보

## 5.9 `order place`

```bash
# 수동 심볼 지정
node src/cli/index.js order place --symbol BTC_KRW --side buy --type limit --price 100000 --amount 5000 --client-order-key ord-001 --json

# 자동 심볼 선택
node src/cli/index.js order place --auto-symbol --side buy --type limit --price 100000 --amount 5000 --client-order-key ord-002 --json
```

필수:

- `--side`
- `--type`
- `--price`
- `--amount`
- 심볼은 `--symbol` 또는 `--auto-symbol` 중 하나

참고:

- 수량(`qty`)은 내부에서 `amount / price`로 자동 계산됩니다.

권장:

- `--client-order-key` 필수 수준으로 사용 권장

실거래 주의:

- 수동 모드에서 `paper off` + 실거래 시 `--confirm YES` 필요
- OpenClaw 모드에서는 확인문 우회

## 5.10 `order unknown` (UNKNOWN_SUBMIT 정리)

```bash
# 단건: 강제 종료(CANCELED)
node src/cli/index.js order unknown --id <order_id> --action force-close --reason manual-cleanup --json

# 단건: 거절 처리(REJECTED)
node src/cli/index.js order unknown --client-order-key <key> --action mark-rejected --json

# 일괄: 모든 UNKNOWN_SUBMIT 정리
node src/cli/index.js order unknown --all --action force-close --reason batch-cleanup --json
```

용도:

- 장기 `UNKNOWN_SUBMIT` 로컬 상태를 운영자가 명시적으로 종료

주의:

- 이 명령은 로컬 상태 정리용입니다.
- 거래소 체결/취소 확정 여부는 `reconcile` 또는 계좌/체결 조회로 재검증하십시오.

## 5.11 주문 가능정보/조회/취소

```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
node src/cli/index.js order list --symbol USDT_KRW --state wait --page 1 --limit 100 --order-by desc --json
node src/cli/index.js order list --symbol USDT_KRW --states wait,done --json
node src/cli/index.js order get --id <exchange_uuid_or_local_id> --symbol USDT_KRW --json
node src/cli/index.js order cancel --id <order_id_or_exchange_id> [--symbol USDT_KRW] --json
```

핵심:

- `order chance`:
  - 빗썸 Private API `/v1/orders/chance` 조회
  - 해당 마켓의 `min_total`, 주문 가능 타입, 수수료 계정 상태 확인용
- `order list`:
  - 빗썸 Private API `/v1/orders` 직접조회
  - 지원 필터: `--symbol`, `--uuids`, `--state`, `--states`, `--page`, `--limit`, `--order-by`
  - `--state`와 `--states`는 동시 사용 불가
- `order get`:
  - 기본은 빗썸 Private API `/v1/order` 직접조회
  - `--id`에 local id를 넣은 경우, 내부적으로 exchange UUID를 복구 시도 후 조회
- `order cancel`:
  - local 주문에 `exchangeOrderId`가 없으면 `clientOrderKey` 기반 조회로 UUID 복구 후 취소 시도
  - local 주문이 없어도 `--id`를 exchange UUID로 넣으면 거래소 취소를 직접 시도

## 5.12 `account list` (계좌 조회)

```bash
node src/cli/index.js account list --json
```

용도:

- 빗썸 계좌 잔고/락 수량 조회
- 조회 결과를 `balancesSnapshot`에도 저장

## 5.13 Kill Switch

```bash
node src/cli/index.js kill-switch on --reason emergency --json
node src/cli/index.js kill-switch off --reason resume --json
```

효과:

- 신규 주문 차단
- 현재 구현에서는 on 시 오픈 주문 취소 시도

## 5.14 Reconcile / Logs

```bash
node src/cli/index.js reconcile run --json
node src/cli/index.js logs tail --json
```

용도:

- `UNKNOWN_SUBMIT` 주문 재조회
- 계좌 스냅샷 동기화(`accountSync`)

추가 동작:

- `exchangeOrderId`가 없는 주문은 `clientOrderKey(identifier)` 기반으로 fallback 조회를 시도
- identifier 조회가 실패하면 최근 주문 목록 기반 fingerprint fallback을 추가 시도

## 6. 응답/에러 계약

### 6.1 성공 응답 예시

```json
{
  "timestamp": "2026-02-13T15:00:00.000Z",
  "command": "order place",
  "status": "ok",
  "code": 0,
  "code_name": "OK",
  "correlation_id": null,
  "data": {
    "id": "...",
    "symbol": "BTC_KRW"
  },
  "error": null
}
```

### 6.2 실패 응답 예시

```json
{
  "timestamp": "2026-02-13T15:00:00.000Z",
  "command": "order place",
  "status": "error",
  "code": 3,
  "code_name": "RISK_REJECTED",
  "correlation_id": null,
  "data": null,
  "error": {
    "message": "Risk policy rejected direct order",
    "type": "RISK_REJECTED",
    "retryable": false,
    "details": {
      "reasons": [{ "rule": "MIN_ORDER_NOTIONAL_KRW", "detail": "1468 < 5000" }]
    }
  }
}
```

### 6.3 Exit Code

| 코드 | 이름                      | 의미                                  |
| ---- | ------------------------- | ------------------------------------- |
| 0    | `OK`                      | 성공                                  |
| 2    | `INVALID_ARGS`            | 인자 오류                             |
| 3    | `RISK_REJECTED`           | 리스크 정책 거절                      |
| 5    | `EXCHANGE_RETRYABLE`      | 거래소 일시 오류(재시도 가능)         |
| 6    | `EXCHANGE_FATAL`          | 거래소 영구 오류                      |
| 7    | `RATE_LIMITED`            | 레이트리밋(현재 코드에서 제한적 사용) |
| 8    | `RECONCILE_MISMATCH`      | 정합성 불일치                         |
| 9    | `KILL_SWITCH_ACTIVE`      | 킬스위치 활성 차단                    |
| 10   | `INTERNAL_ERROR`          | 내부 오류                             |
| 11   | `FORBIDDEN_IN_AGENT_MODE` | 예약 코드(현재 제한 해제 상태)        |

## 7. AI/OpenClaw 운용 패턴 (실전)

## 7.1 표준 매수 루프

1. `status --json`
2. `order pick --json`
3. 선택 종목/가격으로 주문 파라미터 계산
4. `order place --auto-symbol ... --client-order-key ... --json`
5. `order get` 또는 `order list`로 추적

## 7.2 재시도 규칙

- `code=5` 또는 `code=7`:
  - 시스템이 자동 재처리(리컨실+재확인) 수행
  - 미복구가 누적되면 자동 Kill Switch 발동 가능
- `code=2` 또는 `code=3`:
  - 파라미터/리스크 정책 수정 후 재시도
- `code=6`:
  - 거래소 응답 메시지 분석 후 수동개입

## 7.3 멱등키 생성 규칙 권장

예:

- `agent-buy-btc-20260213T1500-001`
- `ai-grid-usdt-20260213-uuid`

규칙:

- 전략/심볼/시간/시퀀스 포함
- 재시도 시 동일 키 유지

## 8. 운영 체크리스트

## 8.1 시작 전

- [ ] `.env` 키 입력 완료
- [ ] 빗썸 허용 IP 등록 완료
- [ ] `status --json` 정상
- [ ] `markets --symbol BTC_KRW --json` 정상
- [ ] 리스크 값 검토 (`RISK_MIN_ORDER_NOTIONAL_KRW` 포함)

## 8.2 실거래 전환 전

- [ ] `paper on`에서 주문/취소/조회 시나리오 점검
- [ ] 에러코드 해석 가능 여부 확인
- [ ] kill-switch on/off 동작 확인
- [ ] 일 손실 기준을 고정하려면 `TRADER_INITIAL_CAPITAL_KRW` 설정

## 8.3 실거래 중

- [ ] 각 주문마다 `--client-order-key` 사용
- [ ] 자동 재처리 파라미터(`TRADER_AUTO_RETRY_*`) 점검
- [ ] 자동 Kill Switch 파라미터(`TRADER_AUTO_KILL_SWITCH_*`) 점검
- [ ] 코드 3 발생 시 리스크값/주문수량 재평가
- [ ] `--auto-symbol` 사용 시 `RISK_AI_*` 하드캡 점검

## 8.4 장애 시

- [ ] `kill-switch on --json`
- [ ] `order list`로 열린 주문 점검
- [ ] 필요 시 개별 `order cancel`
- [ ] 원인 제거 후 `kill-switch off`

## 9. 트러블슈팅 상세

## 9.1 `not allowed client IP`

원인:

- 빗썸 API 키 허용 IP 미등록

대응:

1. 현재 공인 IP 확인
2. 빗썸 API 설정에 IP 등록
3. 재시도

## 9.2 `Missing Bithumb API credentials`

원인:

- `.env` 키 누락/오타

대응:

1. `.env`의 키 2개 확인
2. 쉘 재시작 또는 명령 재실행

## 9.3 `MIN_ORDER_NOTIONAL_KRW`

원인:

- `amount`가 최소 주문금액보다 작음

대응:

1. `amount` 증가
2. 실제 정책값 확인 (`RISK_MIN_ORDER_NOTIONAL_KRW`, `RISK_MIN_ORDER_NOTIONAL_BY_SYMBOL`)

## 9.4 `MAX_CONCURRENT_ORDERS`

원인:

- 열린 주문이 너무 많음

대응:

1. `order list` 확인
2. 필요 주문 취소
3. 한도 상향 검토

## 9.5 `AI_MAX_ORDER_NOTIONAL_KRW` / `AI_MAX_ORDERS_PER_WINDOW` / `AI_MAX_TOTAL_EXPOSURE_KRW`

원인:

- `--auto-symbol` 주문이 AI 하드캡을 초과함

대응:

1. `RISK_AI_MAX_ORDER_NOTIONAL_KRW` 상향 또는 `amount` 축소
2. `RISK_AI_MAX_ORDERS_PER_WINDOW`, `RISK_AI_ORDER_COUNT_WINDOW_SEC` 조정
3. `RISK_AI_MAX_TOTAL_EXPOSURE_KRW` 조정 또는 기존 포지션/열린 주문 정리

## 9.6 `order_not_found`

원인:

- 이미 체결/취소/잘못된 ID

대응:

1. `order list`에서 id 재확인
2. `reconcile run`

## 9.7 일 손실 제한이 적용되지 않는 것처럼 보이는 경우

원인:

- baseline 자본이 명시되지 않았거나 계좌 스냅샷 컨텍스트가 부족함

대응:

1. `.env`에 `TRADER_INITIAL_CAPITAL_KRW` 설정
2. `account list --json`으로 `balancesSnapshot` 갱신
3. 재시도 후 리스크 응답 상세값 확인

## 9.8 `STRATEGY_RSI_DATA_INSUFFICIENT`

원인:

- 유효 캔들 수가 요구치(`period + 1`)보다 작음

대응:

1. `STRATEGY_RSI_CANDLE_COUNT` 증가
2. `candles --json`으로 심볼/간격 데이터 확인
3. `strategy run --name rsi --dry-run --json` 결과에서 RSI 페이로드 확인

## 9.9 RSI 전략이 BUY 주문을 만들지 않는 경우

원인:

- 현재 RSI 값이 BUY 조건(`RSI <= STRATEGY_RSI_OVERSOLD`)을 만족하지 않음

대응:

1. dry-run 결과의 `data.rsi.value` 확인
2. `STRATEGY_RSI_OVERSOLD` 임계값 조정
3. 실행 전 paper/live 모드 재확인

## 10. 보안 운영 수칙

- `.env`를 git에 커밋하지 않기
- 키는 주기적으로 롤오버
- 키 노출 의심 시 즉시 폐기/재발급
- 로그 공유 시 주문ID/키/토큰 마스킹

## 11. 현재 제한사항

- 웹소켓 기반 실시간 체결 동기화는 제한적
- 일 PnL 가드레일은 계좌 스냅샷 기반 추정치(회계 장부 수준 아님)
- 내장 전략 종류는 현재 제한적(RSI 경로 구현)
- 장기 운영용 분석 리포트/대시보드는 미구현 (CLI 로그/JSON 중심)

## 12. 권장 다음 작업

1. 주문 정합성 리컨실 강화(체결/잔고 포함)
2. 체결/수익률 기반 성과 리포트 자동화
3. 웹소켓 기반 체결/주문 상태 동기화 강화
4. PostgreSQL 전환
