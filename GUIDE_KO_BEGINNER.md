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

## 2) 실행형 서비스 시작

```bash
npm start
```

서비스는 `.env`의 `EXECUTION_*` 설정으로 자동매매 루프를 계속 실행합니다.
AI가 `.trader/ai-settings.json`을 갱신하면 다음 AI 설정 스냅샷 갱신 주기(기본 30~60분)부터 자동 반영됩니다.
AI 운용 주기는 30~60분 권장이며, 변경이 없으면 파일을 그대로 유지하면 됩니다.

## 3) 실행 중 상태 확인

```bash
tail -f .trader/http-audit.jsonl
```

```bash
cat .trader/state.json
```

## 4) 오버레이(AI 결과) 넣기 (옵션)

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
    "cooldownSec": 30
  },
  "decision": {
    "mode": "filter",
    "allowBuy": true,
    "allowSell": true
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

AI가 직접 판단해 강제 액션을 내리려면 `decision.mode=override`와 `forceAction`을 함께 사용합니다.

## 5) 긴급 정지 (옵션)

```bash
cat > .trader/ai-settings.json <<'JSON'
{
  "version": 1,
  "updatedAt": "2026-02-15T00:00:00.000Z",
  "execution": { "enabled": true, "symbol": "BTC_KRW", "orderAmountKrw": 5000, "windowSec": 300, "cooldownSec": 30 },
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
  "execution": { "enabled": true, "symbol": "BTC_KRW", "orderAmountKrw": 5000, "windowSec": 300, "cooldownSec": 30 },
  "overlay": { "multiplier": 1.0, "score": null, "regime": null, "note": "kill switch off" },
  "controls": { "killSwitch": false }
}
JSON
```
