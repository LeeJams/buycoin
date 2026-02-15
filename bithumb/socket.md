# Bithumb WebSocket API

## 엔드포인트

| 타입    | URL                                             |
| ------- | ----------------------------------------------- |
| Public  | `wss://ws-api.bithumb.com/websocket/v1`         |
| Private | `wss://ws-api.bithumb.com/websocket/v1/private` |

## 레이트 리밋

- 연결 요청: IP 기준 **초당 10회** 제한
- 연결 후 수신되는 체결/시세 데이터 스트림은 제한 없음

---

## 데이터 타입 개요

### Public (인증 불필요)

| 타입        | 설명        |
| ----------- | ----------- |
| `ticker`    | 현재가 정보 |
| `trade`     | 체결 정보   |
| `orderbook` | 호가 정보   |

### Private (인증 필요)

| 타입      | 설명         |
| --------- | ------------ |
| `myOrder` | 내 주문 정보 |
| `myAsset` | 내 자산 정보 |

---

## 인증 (Private 전용)

REST API와 동일하게 JWT 인증 사용.

**JWT 페이로드:** `access_key`, `nonce(uuid)`, `timestamp` 포함 후 `secretKey`로 서명

**헤더:**

```
authorization: Bearer {jwtToken}
```

**Node.js 연결 예시:**

`jsonwebtoken`, `uuid`, `ws` 라이브러리를 사용해 JWT 생성 후 WebSocket 연결.
`open` 이벤트 시 `ws.send(...)`로 구독 요청 전송.

---

## 요청 포맷

연결 완료 후 요청/응답은 모두 **JSON 배열** 형식.

```
[ {ticket field}, {type field}, ..., {type field}, {format field} ]
```

### Ticket Field

| 필드     | 타입   | 필수 | 설명                                   |
| -------- | ------ | ---- | -------------------------------------- |
| `ticket` | String | O    | 요청자 식별값 (UUID 등 유니크 값 권장) |

### Type Field (공통)

| 필드             | 타입    | 필수 | 기본값  | 설명             |
| ---------------- | ------- | ---- | ------- | ---------------- |
| `type`           | String  | O    |         | 데이터 타입      |
| `codes`          | List    | O    |         | 마켓 코드 리스트 |
| `isOnlySnapshot` | Boolean | X    | `false` | 스냅샷만 수신    |
| `isOnlyRealtime` | Boolean | X    | `false` | 실시간만 수신    |

- 둘 다 생략하면 스냅샷 + 실시간 모두 수신

### Format Field

| 필드     | 타입   | 필수 | 기본값    | 설명                         |
| -------- | ------ | ---- | --------- | ---------------------------- |
| `format` | String | X    | `DEFAULT` | `SIMPLE` 선택 시 필드명 축약 |

---

## 사용 예시

### 연결 테스트

```sh
# wscat
npm install -g wscat
wscat -c wss://ws-api.bithumb.com/websocket/v1

# telsocket
telsocket -url wss://ws-api.bithumb.com/websocket/v1
```

### 단일 마켓 구독 (KRW-BTC ticker)

```sh
wscat -c wss://ws-api.bithumb.com/websocket/v1
```

```json
[{ "ticket": "test example" }, { "type": "ticker", "codes": ["KRW-BTC"] }]
```

**응답 (스냅샷):**

```json
{
  "type": "ticker",
  "code": "KRW-BTC",
  "trade_price": 493100,
  "stream_type": "SNAPSHOT",
  ...
}
```

**이후 실시간 데이터가 `"stream_type": "REALTIME"`으로 계속 수신됨.**

### 복수 마켓 + SIMPLE 포맷

```json
[
  { "ticket": "test example" },
  { "type": "ticker", "codes": ["KRW-BTC", "BTC-ETH"] },
  { "format": "SIMPLE" }
]
```

SIMPLE 포맷에서는 필드명이 축약됨 (예: `type` -> `ty`, `code` -> `cd`, `trade_price` -> `tp`).

---

## 타입별 요청 및 응답

### Ticker (현재가)

#### Request

| 필드             | 타입         | 필수 | 기본값  | 설명                      |
| ---------------- | ------------ | ---- | ------- | ------------------------- |
| `type`           | String       | O    |         | `ticker`                  |
| `codes`          | List[String] | O    |         | 마켓 코드 리스트 (대문자) |
| `isOnlySnapshot` | Boolean      | X    | `false` | 스냅샷만 수신             |
| `isOnlyRealtime` | Boolean      | X    | `false` | 실시간만 수신             |

#### Response

| 필드명                  | 축약형   | 설명                                 | 타입    |
| ----------------------- | -------- | ------------------------------------ | ------- |
| `type`                  | `ty`     | 타입 (`ticker`)                      | String  |
| `code`                  | `cd`     | 마켓 코드 (예: KRW-BTC)              | String  |
| `opening_price`         | `op`     | 시가                                 | Double  |
| `high_price`            | `hp`     | 고가                                 | Double  |
| `low_price`             | `lp`     | 저가                                 | Double  |
| `trade_price`           | `tp`     | 현재가                               | Double  |
| `prev_closing_price`    | `pcp`    | 전일 종가                            | Double  |
| `change`                | `c`      | 전일 대비 (`RISE`, `EVEN`, `FALL`)   | String  |
| `change_price`          | `cp`     | 부호 없는 전일 대비 값               | Double  |
| `signed_change_price`   | `scp`    | 전일 대비 값                         | Double  |
| `change_rate`           | `cr`     | 부호 없는 전일 대비 등락율           | Double  |
| `signed_change_rate`    | `scr`    | 전일 대비 등락율                     | Double  |
| `trade_volume`          | `tv`     | 가장 최근 거래량                     | Double  |
| `acc_trade_volume`      | `atv`    | 누적 거래량 (KST 0시 기준)           | Double  |
| `acc_trade_volume_24h`  | `atv24h` | 24시간 누적 거래량                   | Double  |
| `acc_trade_price`       | `atp`    | 누적 거래대금 (KST 0시 기준)         | Double  |
| `acc_trade_price_24h`   | `atp24h` | 24시간 누적 거래대금                 | Double  |
| `trade_date`            | `tdt`    | 최근 거래 일자 (KST, `yyyyMMdd`)     | String  |
| `trade_time`            | `ttm`    | 최근 거래 시각 (KST, `HHmmss`)       | String  |
| `trade_timestamp`       | `ttms`   | 체결 타임스탬프 (ms)                 | Long    |
| `ask_bid`               | `ab`     | 매수/매도 구분 (`ASK`, `BID`)        | String  |
| `acc_ask_volume`        | `aav`    | 누적 매도량                          | Double  |
| `acc_bid_volume`        | `abv`    | 누적 매수량                          | Double  |
| `highest_52_week_price` | `h52wp`  | 52주 최고가                          | Double  |
| `highest_52_week_date`  | `h52wdt` | 52주 최고가 달성일 (`yyyy-MM-dd`)    | String  |
| `lowest_52_week_price`  | `l52wp`  | 52주 최저가                          | Double  |
| `lowest_52_week_date`   | `l52wdt` | 52주 최저가 달성일 (`yyyy-MM-dd`)    | String  |
| `market_state`          | `ms`     | 거래 상태                            | String  |
| `is_trading_suspended`  | `its`    | 거래 정지 여부                       | Boolean |
| `delisting_date`        | `dd`     | 거래지원 종료일                      | Date    |
| `market_warning`        | `mw`     | 유의 종목 여부 (`NONE`, `CAUTION`)   | String  |
| `timestamp`             | `tms`    | 타임스탬프 (ms)                      | Long    |
| `stream_type`           | `st`     | 스트림 타입 (`SNAPSHOT`, `REALTIME`) | String  |

---

### Trade (체결)

#### Request

| 필드             | 타입         | 필수 | 기본값  | 설명                      |
| ---------------- | ------------ | ---- | ------- | ------------------------- |
| `type`           | String       | O    |         | `trade`                   |
| `codes`          | List[String] | O    |         | 마켓 코드 리스트 (대문자) |
| `isOnlySnapshot` | Boolean      | X    | `false` | 스냅샷만 수신             |
| `isOnlyRealtime` | Boolean      | X    | `false` | 실시간만 수신             |

#### Response

| 필드명               | 축약형 | 설명                                 | 타입   |
| -------------------- | ------ | ------------------------------------ | ------ |
| `type`               | `ty`   | 타입 (`trade`)                       | String |
| `code`               | `cd`   | 마켓 코드 (예: KRW-BTC)              | String |
| `trade_price`        | `tp`   | 체결 가격                            | Double |
| `trade_volume`       | `tv`   | 체결량                               | Double |
| `ask_bid`            | `ab`   | 매수/매도 (`ASK`: 매도, `BID`: 매수) | String |
| `prev_closing_price` | `pcp`  | 전일 종가                            | Double |
| `change`             | `c`    | 전일 대비 (`RISE`, `EVEN`, `FALL`)   | String |
| `change_price`       | `cp`   | 부호 없는 전일 대비 값               | Double |
| `trade_date`         | `tdt`  | 최근 거래 일자 (KST, `yyyy-MM-dd`)   | String |
| `trade_time`         | `ttm`  | 최근 거래 시각 (KST, `HH:mm:ss`)     | String |
| `trade_timestamp`    | `ttms` | 체결 타임스탬프 (ms)                 | Long   |
| `timestamp`          | `tms`  | 타임스탬프 (ms)                      | Long   |
| `sequential_id`      | `sid`  | 체결 번호 (Unique, 순서 비보장)      | Long   |
| `stream_type`        | `st`   | 스트림 타입 (`SNAPSHOT`, `REALTIME`) | String |

---

### Orderbook (호가)

#### Request

| 필드             | 타입         | 필수 | 기본값  | 설명                      |
| ---------------- | ------------ | ---- | ------- | ------------------------- |
| `type`           | String       | O    |         | `orderbook`               |
| `codes`          | List[String] | O    |         | 마켓 코드 리스트 (대문자) |
| `level`          | Double       | X    | `1`     | 호가 모아보기 단위        |
| `isOnlySnapshot` | Boolean      | X    | `false` | 스냅샷만 수신             |
| `isOnlyRealtime` | Boolean      | X    | `false` | 실시간만 수신             |

#### Response

| 필드명                      | 축약형   | 설명                                 | 타입         |
| --------------------------- | -------- | ------------------------------------ | ------------ |
| `type`                      | `ty`     | 타입 (`orderbook`)                   | String       |
| `code`                      | `cd`     | 마켓 코드 (예: KRW-BTC)              | String       |
| `total_ask_size`            | `tas`    | 호가 매도 총 잔량                    | Double       |
| `total_bid_size`            | `tbs`    | 호가 매수 총 잔량                    | Double       |
| `orderbook_units`           | `obu`    | 호가 목록                            | List[Object] |
| `orderbook_units.ask_price` | `obu.ap` | 매도 호가                            | Double       |
| `orderbook_units.bid_price` | `obu.bp` | 매수 호가                            | Double       |
| `orderbook_units.ask_size`  | `obu.as` | 매도 잔량                            | Double       |
| `orderbook_units.bid_size`  | `obu.bs` | 매수 잔량                            | Double       |
| `timestamp`                 | `tms`    | 타임스탬프 (ms)                      | Long         |
| `level`                     | `lv`     | 호가 모아보기 단위 (기본 1)          | Double       |
| `stream_type`               | `st`     | 스트림 타입 (`SNAPSHOT`, `REALTIME`) | String       |

---

### MyOrder (내 주문 및 체결) - Private

#### Request

| 필드    | 타입         | 필수 | 기본값    | 설명                                         |
| ------- | ------------ | ---- | --------- | -------------------------------------------- |
| `type`  | String       | O    |           | `myOrder`                                    |
| `codes` | List[String] | X    | 전체 마켓 | 마켓 코드 리스트 (대문자, 생략 시 전체 구독) |

#### Response

| 필드명             | 축약형 | 설명                                    | 타입   | 비고                              |
| ------------------ | ------ | --------------------------------------- | ------ | --------------------------------- |
| `type`             | `ty`   | 타입                                    | String | `myOrder`                         |
| `code`             | `cd`   | 마켓 코드 (예: KRW-BTC)                 | String |                                   |
| `uuid`             | `uid`  | 주문 고유 아이디                        | String |                                   |
| `ask_bid`          | `ab`   | 매수/매도 구분                          | String | `ASK`(매도), `BID`(매수)          |
| `order_type`       | `ot`   | 주문 타입                               | String | `limit`, `price`, `market`        |
| `state`            | `s`    | 주문 상태                               | String | `wait`, `trade`, `done`, `cancel` |
| `trade_uuid`       | `tuid` | 체결 고유 아이디                        | String |                                   |
| `price`            | `p`    | 주문 가격 / 체결 가격(state=trade일 때) | Double |                                   |
| `volume`           | `v`    | 주문량 / 체결량(state=trade일 때)       | Double |                                   |
| `remaining_volume` | `rv`   | 체결 후 남은 주문 양                    | Double |                                   |
| `executed_volume`  | `ev`   | 체결된 양                               | Double |                                   |
| `trades_count`     | `tc`   | 해당 주문에 걸린 체결 수                | Double |                                   |
| `reserved_fee`     | `rsf`  | 수수료로 예약된 비용                    | Double |                                   |
| `remaining_fee`    | `rmf`  | 남은 수수료                             | Double |                                   |
| `paid_fee`         | `pf`   | 사용된 수수료                           | Double |                                   |
| `executed_funds`   | `ef`   | 체결된 금액                             | Double |                                   |
| `trade_timestamp`  | `ttms` | 체결 타임스탬프 (ms)                    | Long   |                                   |
| `order_timestamp`  | `otms` | 주문 타임스탬프 (ms)                    | Long   |                                   |
| `timestamp`        | `tms`  | 타임스탬프 (ms)                         | Long   |                                   |
| `stream_type`      | `st`   | 스트림 타입                             | String | `REALTIME`                        |

---

### MyAsset (내 자산) - Private

> [API 문서 참고](https://apidocs.bithumb.com/reference/%EB%82%B4-%EC%9E%90%EC%82%B0-myasset)

#### Request

| 필드   | 타입   | 필수 | 설명      |
| ------ | ------ | ---- | --------- |
| `type` | String | O    | `myAsset` |

#### Response

| 필드명            | 축약형   | 설명                    | 타입         | 비고         |
| ----------------- | -------- | ----------------------- | ------------ | ------------ |
| `type`            | `ty`     | 타입                    | String       | `myAsset`    |
| `assets`          | `ast`    | 자산 리스트             | List[Object] |              |
| `assets.currency` | `ast.cu` | 화폐 코드 (영문 대문자) | String       | 예: KRW, BTC |
| `assets.balance`  | `ast.b`  | 주문가능 수량           | Double       |              |
| `assets.locked`   | `ast.l`  | 주문 중 묶여있는 수량   | Double       |              |
| `asset_timestamp` | `asttms` | 자산 타임스탬프 (ms)    | Long         |              |
| `timestamp`       | `tms`    | 메시지 타임스탬프 (ms)  | Long         |              |
| `stream_type`     | `st`     | 스트림 타입             | String       | `REALTIME`   |

## 연결 관리

Connection 관리
PING/PONG
빗썸 API WebSocket 서버는 커넥션을 안정적으로 관리/유지하기 위해 WebSocket PING/PONG Frame을 제공합니다.
(참고 문서 : https://tools.ietf.org/html/rfc6455#section-5.5.2 )

Client to Server PING
기본적으로 서버는 아무런 데이터도 수신, 발신 되지 않은 채 약 120초가 경과하면 Idle Timeout으로 WebSocket Connection을 종료합니다.
이를 방지하기 위해 클라이언트에서 서버로 PING 메시지를 보내서 Connection을 유지하고, WebSocket 서버의 상태와 WebSocket Connection Status를 파악할 수 있습니다.
빗썸 API WebSocket 서버에서는 PING Frame 수신 대응이 준비되어 있습니다. 간단한 구현으로 클라이언트에서 PING 요청/PONG 응답(PING에 대한 응답 Frame)을 통해 서버 상태를 파악할 수 있습니다.
이에 대한 구성은 해당 클라이언트 개발 문서를 확인하시기 바랍니다.
(대부분의 라이브러리는 ping 함수가 내장되어 있을 가능성이 높습니다.)
이외 PING 메시지를 보내 Connection을 유지할 수 있습니다.
Connection이 유지되고 있으면 {"status":"UP"} 응답을 10초 간격으로 받을 수 있습니다.
Shell

$ wscat -c wss://ws-api.bithumb.com/websocket/v1
Connected (press CTRL+C to quit)

PING

{"status":"UP"}
{"status":"UP"}
{"status":"UP"}
