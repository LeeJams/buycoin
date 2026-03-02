# TICKET 03 — 실행 중심 KPI 보고 포맷

## 목표
설정 변경 보고가 아니라 **실행 결과** 중심으로 보고한다.

## 텔레그램 보고 포맷 (최대 7줄)

```text
[코마 2시간 보고]
1) 결론: WRITE/NO_WRITE, regime, killSwitch
2) 실행결과: attempted/successful/rejected, fillCount
3) 손익: realizedPnL, unrealizedPnL, winRate
4) 포지션: KRW, BTC, ETH(수량/평단/평가)
5) 실패원인 Top3: code(reason) x count
6) 변경값: ai-runtime before->after (없으면 변경 없음)
7) 다음 점검 시각
```

## 데이터 소스
- `.trader/state.json`
- `.trader/execution-kpi-summary.json`
- `.trader/execution-kpi-report.jsonl`
- `.trader/ai-runtime.json`, `.trader/ai-settings.json`

## 필수 KPI 정의
- attemptedOrders
- successfulOrders
- rejectedOrders
- fillCount (buy/sell)
- realizedPnlKrw
- unrealizedPnlKrw (보유 평가 기반)
- winRatePct
- rejectTopReasons[3]

## 구현 포인트
- reject reason 집계 함수 추가 (`aggregateRejectReasons(window)`)
- 포지션 평가 함수 추가 (`markToMarket(holdings, latestPrices)`)
- 보고 문자열 생성기 추가 (`buildKpiReportText(metrics)`)

## 수용 기준
- 매 보고마다 실행 지표 6개 이상이 숫자로 채워진다.
- NO_WRITE여도 실행 KPI(주문 시도/거절/손익)는 보고된다.
- 과거 오류와 현재 상태를 분리해 보고한다.
