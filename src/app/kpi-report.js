#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function aggregateRejectReasons(state = {}, fromMs = 0, limit = 3) {
  const counts = new Map();
  const riskEvents = Array.isArray(state.riskEvents) ? state.riskEvents : [];
  for (const row of riskEvents) {
    if (String(row?.type || "") !== "order_rejected") {
      continue;
    }
    const ts = Date.parse(row?.at || 0);
    if (Number.isFinite(ts) && ts < fromMs) {
      continue;
    }

    const reasons = Array.isArray(row?.reasons) ? row.reasons : [];
    if (reasons.length > 0) {
      for (const reason of reasons) {
        const key = String(reason?.rule || reason?.detail || "unknown_reject");
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      continue;
    }

    const key = String(row?.reason || row?.code || "unknown_reject");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function latestBalances(state = {}) {
  const snaps = Array.isArray(state.balancesSnapshot) ? state.balancesSnapshot : [];
  const last = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  return Array.isArray(last?.items) ? last.items : [];
}

function markToMarket(accounts = [], latestPrices = {}) {
  const result = {
    krw: 0,
    assets: [],
    unrealizedPnlKrw: null,
  };

  for (const a of accounts) {
    const currency = String(a?.currency || "").toUpperCase();
    const qty = toNum(a?.balance, 0) + toNum(a?.locked, 0);
    const avgBuyPrice = toNum(a?.avgBuyPrice, 0);
    if (!currency || qty <= 0) {
      continue;
    }
    if (currency === "KRW") {
      result.krw += qty;
      continue;
    }
    const symbol = `${currency}_KRW`;
    const lastPrice = toNum(latestPrices[symbol], null);
    const valuation = Number.isFinite(lastPrice) ? qty * lastPrice : null;
    const cost = avgBuyPrice > 0 ? qty * avgBuyPrice : null;
    const pnl = valuation !== null && cost !== null ? valuation - cost : null;
    result.assets.push({
      symbol,
      qty,
      avgBuyPrice,
      lastPrice,
      valuationKrw: valuation,
      unrealizedPnlKrw: pnl,
    });
  }

  const pnlSum = result.assets
    .map((x) => x.unrealizedPnlKrw)
    .filter((x) => Number.isFinite(x))
    .reduce((a, b) => a + b, 0);
  result.unrealizedPnlKrw = Number.isFinite(pnlSum) ? pnlSum : null;
  return result;
}

function extractLatestPrices(state = {}) {
  const md = state.marketData;
  if (!md || typeof md !== "object") {
    return {};
  }
  const out = {};
  for (const [symbol, row] of Object.entries(md)) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const p = toNum(row.tradePrice ?? row.close ?? row.price, null);
    if (Number.isFinite(p)) {
      out[symbol] = p;
    }
  }
  return out;
}

function marketChangePct(c = {}) {
  if (Number.isFinite(toNum(c?.change24hPct, NaN))) return toNum(c.change24hPct, 0);
  if (Number.isFinite(toNum(c?.changePct24h, NaN))) return toNum(c.changePct24h, 0);
  if (Number.isFinite(toNum(c?.signedChangeRate, NaN))) return toNum(c.signedChangeRate, 0) * 100;
  if (Number.isFinite(toNum(c?.changeRate, NaN))) return toNum(c.changeRate, 0) * 100;
  return 0;
}

function summarizeMarket(universe = {}, signal = {}) {
  const candidates = Array.isArray(universe?.candidates) ? universe.candidates : [];
  if (candidates.length === 0) {
    return "시장 데이터 없음";
  }

  const normalized = candidates.map((c) => ({ ...c, _changePct: marketChangePct(c) }));
  const sortedByChange = [...normalized].sort((a, b) => b._changePct - a._changePct);
  const top = sortedByChange.slice(0, 3).map((c) => `${toKoreanSymbol(c.symbol)} ${c._changePct.toFixed(1)}%`);

  const avgChange = normalized.reduce((acc, c) => acc + c._changePct, 0) / normalized.length;
  const upCount = normalized.filter((c) => c._changePct > 0.2).length;
  const downCount = normalized.filter((c) => c._changePct < -0.2).length;
  const tone = avgChange >= 1 ? "강세" : avgChange <= -1 ? "약세" : "혼조";

  const buySignals = toNum(signal?.buySignals, 0);
  const sellSignals = toNum(signal?.sellSignals, 0);
  const signalHint = buySignals + sellSignals > 0
    ? `신호 buy:${buySignals} / sell:${sellSignals}`
    : "신호 데이터 없음";

  return `${tone} (상승 ${upCount} / 하락 ${downCount}) | 상위: ${top.join(", ")} | 근거: ${signalHint}`;
}

function collectRecentTrades(state = {}, fromMs = 0, limit = 5) {
  const orders = Array.isArray(state?.orders) ? state.orders : [];
  const done = orders.filter((o) => String(o?.state || "").toUpperCase() === "DONE");
  const filtered = done.filter((o) => {
    const ts = Date.parse(o?.placedAt || o?.createdAt || 0);
    return Number.isFinite(ts) && ts >= fromMs;
  });
  const source = filtered.length > 0 ? filtered : done;
  return source.slice(-limit).reverse().map((o) => ({
    when: String(o?.placedAt || o?.createdAt || "").replace("T", " ").replace("Z", "").slice(0, 16),
    side: String(o?.side || "").toUpperCase(),
    symbol: o?.symbol || "?",
    amountKrw: toNum(o?.amountKrw, 0),
    price: toNum(o?.expectedPrice ?? o?.price, 0),
  }));
}

function buildSituationPlan({ attempted = 0, successful = 0, buySignals = 0, rejected = 0 }) {
  if (attempted === 0 && buySignals > 0) {
    return "신호는 있으나 주문이 없음: 진입 필터/시도 제한을 완화해 체결 가능성 점검";
  }
  if (attempted > 0 && successful === 0) {
    return "주문은 시도했으나 체결 실패: 거절 원인 우선 제거(현금/최소주문/가격 조건)";
  }
  if (successful > 0 && rejected > successful) {
    return "체결은 있으나 거절 과다: 심볼/시도수 유지하되 거절률 우선 축소";
  }
  return "체결 품질 유지: 과매매 억제하며 수익 구간 추적";
}

function toKoreanSymbol(symbol = "") {
  const map = {
    BTC_KRW: "비트코인",
    ETH_KRW: "이더리움",
    XRP_KRW: "리플",
    SOL_KRW: "솔라나",
    VIRTUAL_KRW: "버추얼",
    HBAR_KRW: "헤데라",
    DOGE_KRW: "도지코인",
    WLD_KRW: "월드코인",
    ENSO_KRW: "엔소",
  };
  return map[symbol] || symbol;
}

function buildKpiReportText(input) {
  const rejectTop = input.rejectTopReasons.length > 0
    ? input.rejectTopReasons.map((x) => `${x.reason} x${x.count}`).join(", ")
    : "없음";
  const successRateText = input.attempted > 0
    ? `${((input.successful / input.attempted) * 100).toFixed(1)}%`
    : "N/A";
  const failRateText = input.attempted > 0
    ? `${((input.rejected / input.attempted) * 100).toFixed(1)}%`
    : "N/A";

  const configuredSymbolsText = Array.isArray(input.executionSymbols) && input.executionSymbols.length > 0
    ? input.executionSymbols.map((s) => toKoreanSymbol(s)).join(", ")
    : "없음";

  const recentTradesText = input.recentTrades.length > 0
    ? input.recentTrades
      .slice(0, 3)
      .map((t) => `${t.when} ${t.side === "BUY" ? "매수" : "매도"} ${toKoreanSymbol(t.symbol)} ${Math.round(t.amountKrw).toLocaleString()}원`)
      .join(" / ")
    : "최근 체결 없음";

  const positionText = input.mtm.assets.length > 0
    ? input.mtm.assets.map((a) => `${toKoreanSymbol(a.symbol)} ${a.qty.toFixed(6)}`).join(", ")
    : "보유 없음";

  return [
    "[코마 요약 보고]",
    `• 설정 코인: ${configuredSymbolsText}`,
    `• 시장 상황: ${input.marketSummary}`,
    `• 시도/성공/실패: ${input.attempted}/${input.successful}/${input.rejected} (성공률 ${successRateText}, 실패율 ${failRateText})`,
    `• 최근 거래: ${recentTradesText}`,
    `• 기준손익: ${Math.round(input.baselinePnlKrw).toLocaleString()}원 (기준 ${Math.round(input.baselineEquityKrw).toLocaleString()} → 현재 ${Math.round(input.currentEquityKrw).toLocaleString()})`,
    `• 현재 상태: KRW ${Math.round(input.mtm.krw).toLocaleString()}원, 보유 ${positionText}`,
    `• 실패원인: ${rejectTop}`,
    `• 다음 계획: ${input.situationPlan}`,
  ].join("\n");
}

export async function generateKpiReport(baseDir = process.cwd()) {
  const traderDir = path.join(baseDir, ".trader");
  const [state, summary, aiRuntime, operatorBaseline, marketUniverse] = await Promise.all([
    readJson(path.join(traderDir, "state.json"), {}),
    readJson(path.join(traderDir, "execution-kpi-summary.json"), {}),
    readJson(path.join(traderDir, "ai-runtime.json"), {}),
    readJson(path.join(traderDir, "operator-baseline.json"), null),
    readJson(path.join(traderDir, "market-universe.json"), {}),
  ]);

  const s = summary?.summary || {};
  const windowSec = toNum(summary?.reportWindow?.requestedWindowSec, 0);
  const windowLabel = windowSec > 0 ? `${Math.round(windowSec / 60)}분` : "unknown";
  const fromMs = toNum(s?.windowFromMs, 0);
  const attempted = toNum(s?.orders?.attempted, 0);
  const successful = toNum(s?.orders?.successful, 0);
  const fillCount = toNum(s?.fills?.fillCount, 0);
  const buySignals = toNum(s?.signals?.buySignals, 0);
  const sellSignals = toNum(s?.signals?.sellSignals, 0);
  const rejected = Math.max(0, attempted - successful);
  const realizedPnlKrw = toNum(s?.realized?.realizedPnlKrw, 0);
  const winRatePct = toNum(s?.realized?.winRatePct, 0);

  const latestPrices = extractLatestPrices(state);
  const mtm = markToMarket(latestBalances(state), latestPrices);
  const rejectTopReasons = aggregateRejectReasons(state, fromMs, 3);
  const recentTrades = collectRecentTrades(state, fromMs, 5);
  const marketSummary = summarizeMarket(marketUniverse, { buySignals, sellSignals });
  const situationPlan = buildSituationPlan({ attempted, successful, buySignals, rejected });

  const decision = `regime=${aiRuntime?.overlay?.regime || "unknown"}, killSwitch=${Boolean(aiRuntime?.controls?.killSwitch)}`;
  const changeSummary = `ai-runtime updatedAt=${aiRuntime?.updatedAt || "n/a"}`;

  const currentEquityKrw = toNum(mtm.krw, 0)
    + mtm.assets
      .map((x) => toNum(x.valuationKrw, 0))
      .reduce((a, b) => a + b, 0);
  const baselineEquityKrw = toNum(operatorBaseline?.baselineEquityKrw, currentEquityKrw);
  const baselinePnlKrw = currentEquityKrw - baselineEquityKrw;

  const next = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const nextCheckAtKst = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(next).replace(/\. /g, "-").replace(".", "").replace(" ", " ");

  return {
    attempted,
    successful,
    rejected,
    fillCount,
    buySignals,
    realizedPnlKrw,
    winRatePct,
    mtm,
    rejectTopReasons,
    recentTrades,
    marketSummary,
    situationPlan,
    decision,
    changeSummary,
    windowLabel,
    currentEquityKrw,
    baselineEquityKrw,
    baselinePnlKrw,
    nextCheckAtKst,
    text: buildKpiReportText({
      attempted,
      successful,
      rejected,
      fillCount,
      buySignals,
      realizedPnlKrw,
      winRatePct,
      mtm,
      rejectTopReasons,
      recentTrades,
      marketSummary,
      situationPlan,
      decision,
      changeSummary,
      windowLabel,
      executionSymbols: aiRuntime?.execution?.symbols || [],
      currentEquityKrw,
      baselineEquityKrw,
      baselinePnlKrw,
      nextCheckAtKst,
    }),
  };
}

async function main() {
  const report = await generateKpiReport(process.cwd());
  process.stdout.write(`${report.text}\n`);
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  });
}
