# buycoin-trader 초보 가이드

이 버전은 정통 자동매매 구조로 동작합니다.

- 실행 경로: 룰 기반 (빠른 응답)
- 기본 전략: 리스크-관리 모멘텀
- AI: 실행 판단이 아니라 포지션 배율 보정만 담당

## 1) 준비

```bash
cd ./buycoin
npm install
```

`.env`에 빗썸 키를 입력하세요.
페이퍼 모드 기본 초기자금은 100만원입니다(`TRADER_PAPER_INITIAL_CASH_KRW`).

## 2) 실행형 서비스 시작

```bash
npm start
```

서비스는 `.env`의 `EXECUTION_*` 설정으로 자동매매 루프를 계속 실행합니다.
AI가 `.trader/ai-settings.json`을 갱신하면 다음 실행 윈도우부터 자동 반영됩니다.

## 3) 먼저 실행 경로 점검

```bash
npm run start:once
```

## 4) API/소켓 연결 전체 점검(조회 전용)

```bash
npm run smoke
```

이 명령은 다음을 한 번에 확인합니다.

- Private REST: 계좌/주문가능정보/주문리스트
- Public REST: 현재가/분일주월 캔들
- Public WS: ticker/trade/orderbook
- Private WS: myAsset/myOrder 연결 열림 여부

## 5) 주문+취소까지 자동 점검(실거래, 옵션)

```bash
npm run smoke:write
```

실행 조건:

- `TRADER_PAPER_MODE=false`
- `SMOKE_ENABLE_WRITES=true`
- `SMOKE_WRITE_CONFIRM=YES_I_UNDERSTAND`

## 6) 운영 점검/수동 제어가 필요할 때(옵션)

```bash
cat .trader/state.json
```

## 7) HTTP 감사로그 리포트 확인(옵션)

```bash
npm run audit:report
```

감사로그 파일 기본 위치는 `.trader/http-audit.jsonl` 입니다.

## 8) 오버레이(AI 결과) 넣기 (옵션)

```bash
cat > .trader/ai-settings.json <<'JSON'
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": {
    "enabled": true,
    "symbol": "BTC_KRW",
    "orderAmountKrw": 5000,
    "windowSec": 300,
    "cooldownSec": 30,
    "dryRun": true
  },
  "overlay": {
    "multiplier": 0.8,
    "score": -0.3,
    "regime": "risk_off",
    "note": "manual test"
  },
  "controls": {
    "killSwitch": false
  }
}
JSON
```

오버레이는 주문 타이밍을 바꾸지 않고 주문금액 배율만 조정합니다.

## 9) 긴급 정지 (옵션)

```bash
cat > .trader/ai-settings.json <<'JSON'
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": { "enabled": true, "symbol": "BTC_KRW", "orderAmountKrw": 5000, "windowSec": 300, "cooldownSec": 30, "dryRun": true },
  "overlay": { "multiplier": 1.0, "score": null, "regime": null, "note": "kill switch on" },
  "controls": { "killSwitch": true }
}
JSON
```

재개:

```bash
cat > .trader/ai-settings.json <<'JSON'
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": { "enabled": true, "symbol": "BTC_KRW", "orderAmountKrw": 5000, "windowSec": 300, "cooldownSec": 30, "dryRun": true },
  "overlay": { "multiplier": 1.0, "score": null, "regime": null, "note": "kill switch off" },
  "controls": { "killSwitch": false }
}
JSON
```
