# buycoin-trader 완전 입문 가이드 (비개발자용)

문서 버전: 2026-02-14  
대상 경로: `./` (프로젝트 루트)

이 문서는 "코드를 거의 모르는 사용자"가 실제로 매매를 운영할 수 있게 만든 실전 가이드입니다.
아래 순서대로 그대로 따라오면 됩니다.

---

## 1) 먼저 알아둘 핵심 5가지

1. 이 프로그램은 **명령어(CLI)** 로만 동작합니다.
2. 키 입력은 `.env` 파일에 하며, 키를 명령어에 직접 쓰지 않습니다.
3. 기본은 `paper mode`(모의주문)입니다. 실거래는 직접 `paper off` 해야 합니다.
4. 라이브 주문 전에 시스템이 자동으로 빗썸 `order chance`를 조회해서 최소주문금액(`min_total`)을 확인합니다.
5. OpenClaw 모드에서는 에이전트가 주문 명령을 직접 실행할 수 있습니다.

---

## 2) 용어를 아주 쉽게

- `paper mode`: 가짜 주문. 실제 돈이 안 나갑니다.
- `live mode`: 실거래 주문. 실제 체결됩니다.
- `symbol`: 거래쌍. 예: `USDT_KRW`, `BTC_KRW`
- `amount`: 원화 기준 주문금액(KRW)
- `price`: 지정가 주문 가격
- `order chance`: 해당 마켓의 주문 가능 정보(최소주문금액, 수수료, 주문 타입)
- `kill-switch`: 긴급정지. 신규 주문 차단 + 열린 주문 취소 시도
- `client-order-key`: 중복 주문 방지 키(아주 중요)

---

## 3) 처음 1회 설정 (복붙용)

### 3-1. 폴더 이동

```bash
cd ./buycoin
```

### 3-2. 설치

```bash
npm install
```

### 3-3. `.env` 준비

이미 `.env`가 있으면 수정만 하면 됩니다.

```env
BITHUMB_ACCESS_KEY=여기에_빗썸_액세스키
BITHUMB_SECRET_KEY=여기에_빗썸_시크릿키

# API 초당 제한 (빗썸 공식 제한 맞춤)
BITHUMB_PUBLIC_MAX_PER_SEC=150
BITHUMB_PRIVATE_MAX_PER_SEC=140

# 시작은 반드시 모의주문
TRADER_PAPER_MODE=true

# 기본 종목 (원하면 변경)
TRADER_DEFAULT_SYMBOL=USDT_KRW

# OpenClaw 에이전트 사용 시 true
OPENCLAW_AGENT=true

# 기본 리스크
RISK_MIN_ORDER_NOTIONAL_KRW=5000
RISK_MAX_CONCURRENT_ORDERS=5
RISK_MAX_ORDER_NOTIONAL_KRW=300000
RISK_DAILY_LOSS_LIMIT_KRW=500000

# AI 자동 종목선택(--auto-symbol) 전용 하드캡
RISK_AI_MAX_ORDER_NOTIONAL_KRW=100000
RISK_AI_MAX_ORDERS_PER_WINDOW=3
RISK_AI_ORDER_COUNT_WINDOW_SEC=60
RISK_AI_MAX_TOTAL_EXPOSURE_KRW=500000
```

설명:
- 위 `RISK_AI_*` 4개는 `--auto-symbol` 주문에만 적용됩니다.
- 수동 심볼 주문(`--symbol`)은 기존 일반 리스크(`RISK_MAX_ORDER_NOTIONAL_KRW` 등)만 적용됩니다.

---

## 4) 설치 직후 정상동작 확인

아래 4개는 반드시 먼저 실행하세요.

### 4-1. 상태 확인

```bash
node src/cli/index.js status --json
```

확인 포인트:
- `code: 0`
- `settings.paperMode: true`

### 4-2. 헬스 체크

```bash
node src/cli/index.js health --check-exchange --json
```

확인 포인트:
- `summary.status`가 `HEALTHY` 또는 `DEGRADED`
- 키가 유효하면 `exchange_private_api` 체크가 `PASS`

### 4-3. 시세 확인

```bash
node src/cli/index.js markets --symbol USDT_KRW --json
```

### 4-4. 주문가능정보 확인 (중요)

```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
```

확인 포인트:
- `data.chance.market.bid.min_total`
- `data.chance.market.ask.min_total`

`min_total`이 5000이면 5000원 미만 주문은 거절됩니다.

---

## 5) 가장 안전한 시작 순서 (권장)

1. `paper mode`로 3~5회 모의 주문
2. 주문 조회/취소/정리 명령 익히기
3. 아주 작은 금액으로 실거래 1회
4. 결과 확인 후 점진 확대

---

## 6) 모의주문 연습 (실수 방지)

### 6-1. 모드 확인

```bash
node src/cli/index.js paper on --json
node src/cli/index.js status --json
```

`paperMode: true`면 모의주문입니다.

### 6-2. 지정가 매수 (금액 기반)

```bash
node src/cli/index.js order place --symbol USDT_KRW --side buy --type limit --price 1467 --amount 5000 --client-order-key practice-001 --json
```

설명:
- `amount=5000`: 5천원어치
- 내부에서 수량은 자동 계산

### 6-3. 주문 조회

```bash
node src/cli/index.js order list --symbol USDT_KRW --state wait --limit 20 --json
node src/cli/index.js order get --id <위_응답의_id> --json
```

### 6-4. 주문 취소

```bash
node src/cli/index.js order cancel --id <위_응답의_id> --symbol USDT_KRW --json
```

---

## 7) 실거래 전환 (주의)

### 7-1. 실거래 모드 전환

```bash
node src/cli/index.js paper off --json
node src/cli/index.js status --json
```

### 7-2. 라이브 주문 전 필수 체크

```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
```

이 값으로 최소주문금액이 동적으로 강제됩니다.
즉, 설정값이 5000이고 거래소 `min_total`도 5000이면 최소 5000원부터 주문됩니다.

### 7-3. 수동 주문 (사람 실행 시 confirm 필요)

```bash
node src/cli/index.js order place --symbol USDT_KRW --side buy --type limit --price 1467 --amount 5000 --client-order-key live-001 --confirm YES --json
```

---

## 8) OpenClaw(에이전트) 운영 방법

`OPENCLAW_AGENT=true`이면 에이전트 모드입니다.

권장 흐름:
1. 에이전트가 `order chance`로 최소주문금액/주문가능상태 확인
2. 에이전트가 `order pick`으로 종목 선택
3. `RISK_AI_*` 하드캡 범위 확인
4. `order place --auto-symbol ... --client-order-key ...` 실행
5. `order list/get`으로 확인
6. 필요 시 `order cancel` 또는 `kill-switch on`

예시:

```bash
node src/cli/index.js order pick --side buy --select-mode momentum --candidates BTC_KRW,ETH_KRW,USDT_KRW --json
node src/cli/index.js order place --auto-symbol --side buy --type limit --price 1467 --amount 5000 --client-order-key ai-001 --json
```

---

## 9) 주문 관련 명령, 실사용 기준 설명

### 9-1. 주문가능정보

```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
```

언제 쓰나:
- 주문 직전
- 최소주문금액/수수료/마켓 상태 확인

### 9-2. 주문목록

```bash
node src/cli/index.js order list --symbol USDT_KRW --state wait --page 1 --limit 100 --order-by desc --json
```

옵션:
- `--uuids id1,id2`
- `--state wait|watch|done|cancel`
- `--states wait,done`
- `--page 1`
- `--limit 1~100`
- `--order-by asc|desc`

주의:
- `--state`와 `--states`는 같이 쓰면 에러

### 9-3. 개별 주문조회

```bash
node src/cli/index.js order get --id <order_id_or_uuid> --symbol USDT_KRW --json
```

동작:
- exchange UUID면 바로 거래소 조회
- local id여도 내부적으로 UUID 복구를 시도

### 9-4. 주문취소

```bash
node src/cli/index.js order cancel --id <order_id_or_uuid> [--symbol USDT_KRW] --json
```

동작:
1. 로컬 주문이 있으면 로컬 기준 취소
2. 로컬 주문에 UUID가 없으면 `client-order-key`로 UUID 복구 후 취소
3. 로컬 주문이 없어도 `id`를 exchange UUID로 직접 취소 가능

---

## 10) 실수 방지 규칙 (중요)

1. 항상 `--json` 사용
2. 항상 `--client-order-key` 사용
3. 라이브 주문 전 `order chance` 확인
4. AI 자동주문 시 `RISK_AI_*` 하드캡을 먼저 설정
5. 최초 실거래는 1회 5000~10000원으로 시작
6. 이상 징후 시 즉시 `kill-switch on`

긴급정지:

```bash
node src/cli/index.js kill-switch on --reason emergency --json
```

재개:

```bash
node src/cli/index.js kill-switch off --reason resume --json
```

---

## 11) 자주 발생하는 에러와 대처

### 11-1. `RISK_REJECTED`

의미:
- 리스크 규칙 위반

대표 원인:
- 최소주문금액 미만
- 동시주문수 초과
- AI 1회 주문금액 하드캡 초과(`AI_MAX_ORDER_NOTIONAL_KRW`)
- AI 시간창 주문횟수 하드캡 초과(`AI_MAX_ORDERS_PER_WINDOW`)
- AI 총노출 하드캡 초과(`AI_MAX_TOTAL_EXPOSURE_KRW`)
- kill-switch ON

대처:
1. `order chance`에서 `min_total` 확인
2. `amount`를 올리기
3. `RISK_AI_*` 값 점검 (`--auto-symbol` 사용 시)
4. `status`에서 kill-switch 상태 확인

### 11-2. `EXCHANGE_RETRYABLE` / `RATE_LIMITED`

의미:
- 일시적 네트워크/거래소/요청 제한 문제

대처:
1. 잠시 후 재시도
2. `health --check-exchange --json` 확인
3. 자동 재시도/리컨실 동작 후 상태 재확인

### 11-3. `Order has no exchange UUID`

의미:
- 주문 기록은 있지만 거래소 UUID를 아직 못 찾음

대처:
1. `reconcile run --json`
2. `order get --id ...`
3. 필요 시 `order unknown --action force-close ...`

---

## 12) 매일 운영 체크리스트

아침 시작:
1. `status --json`
2. `health --check-exchange --json`
3. `order chance --symbol USDT_KRW --json`
4. `account list --json`

주문 전:
1. `order chance` 재확인
2. `amount`가 최소주문금액 이상인지 확인
3. (`--auto-symbol`이면) `RISK_AI_*` 하드캡 범위 확인
4. `client-order-key` 부여

주문 후:
1. `order get --id ...`
2. `order list --state wait ...`
3. 이상 시 `order cancel` 또는 `kill-switch on`

---

## 13) 복사해서 바로 쓰는 명령 모음

### 13-1. 기본 점검

```bash
node src/cli/index.js status --json
node src/cli/index.js health --check-exchange --json
node src/cli/index.js account list --json
```

### 13-2. 주문가능정보 + 시세

```bash
node src/cli/index.js order chance --symbol USDT_KRW --json
node src/cli/index.js markets --symbol USDT_KRW --json
node src/cli/index.js candles --symbol USDT_KRW --interval 1m --count 30 --json
```

### 13-3. 모의주문

```bash
node src/cli/index.js paper on --json
node src/cli/index.js order place --symbol USDT_KRW --side buy --type limit --price 1467 --amount 5000 --client-order-key demo-001 --json
node src/cli/index.js order list --symbol USDT_KRW --limit 20 --json
```

### 13-4. 실거래

```bash
node src/cli/index.js paper off --json
node src/cli/index.js order place --symbol USDT_KRW --side buy --type limit --price 1467 --amount 5000 --client-order-key live-001 --confirm YES --json
```

### 13-5. 취소/정지

```bash
node src/cli/index.js order cancel --id <order_id_or_uuid> --symbol USDT_KRW --json
node src/cli/index.js kill-switch on --reason emergency --json
```

---

## 14) 마지막 요약

1. 처음엔 무조건 `paper mode`로 연습
2. 라이브 전에 항상 `order chance` 확인
3. 주문은 항상 `client-order-key` 포함
4. 이상하면 즉시 `kill-switch on`
5. 모르면 먼저 `status`, `health`, `order chance`, `account list` 순서로 점검
