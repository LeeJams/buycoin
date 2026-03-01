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

function buildKpiReportText(input) {
  const rejectTop = input.rejectTopReasons.length > 0
    ? input.rejectTopReasons.map((x) => `${x.reason} x${x.count}`).join(", ")
    : "none";
  const assetsText = input.mtm.assets.length > 0
    ? input.mtm.assets
      .map((a) => `${a.symbol} ${a.qty.toFixed(8)} @${Math.round(a.avgBuyPrice).toLocaleString()}`)
      .join(" | ")
    : "none";

  const successRateText = input.attempted > 0
    ? `${((input.successful / input.attempted) * 100).toFixed(2)}%`
    : "N/A(attempted=0)";
  const rejectRateText = input.attempted > 0
    ? `${((input.rejected / input.attempted) * 100).toFixed(2)}%`
    : "N/A(attempted=0)";

  const configuredSymbolsText = Array.isArray(input.executionSymbols) && input.executionSymbols.length > 0
    ? input.executionSymbols.join(",")
    : "none";

  return [
    "[코마 2시간 보고]",
    `1) 결론: ${input.decision}`,
    `2) 관측윈도우: ${input.windowLabel}`,
    `3) 실행결과: attempted=${input.attempted}, successful=${input.successful}, rejected=${input.rejected}, fills=${input.fillCount}`,
    `4) 성공률/거절률: success=${successRateText}, reject=${rejectRateText}`,
    `5) 설정 심볼: ${configuredSymbolsText}`,
    `6) 손익: realized=${Math.round(input.realizedPnlKrw).toLocaleString()} KRW, unrealized=${Math.round(toNum(input.mtm.unrealizedPnlKrw, 0)).toLocaleString()} KRW, winRate=${input.winRatePct}%`,
    `7) 기준손익: baseline=${Math.round(input.baselineEquityKrw).toLocaleString()} KRW, equity=${Math.round(input.currentEquityKrw).toLocaleString()} KRW, pnl=${Math.round(input.baselinePnlKrw).toLocaleString()} KRW`,
    `8) 포지션: KRW ${Math.round(input.mtm.krw).toLocaleString()}, ${assetsText}`,
    `9) 실패원인 Top3: ${rejectTop}`,
    `10) 변경값: ${input.changeSummary}`,
    `11) 다음 점검 시각: ${input.nextCheckAtKst}`,
  ].join("\n");
}

export async function generateKpiReport(baseDir = process.cwd()) {
  const traderDir = path.join(baseDir, ".trader");
  const [state, summary, aiRuntime, operatorBaseline] = await Promise.all([
    readJson(path.join(traderDir, "state.json"), {}),
    readJson(path.join(traderDir, "execution-kpi-summary.json"), {}),
    readJson(path.join(traderDir, "ai-runtime.json"), {}),
    readJson(path.join(traderDir, "operator-baseline.json"), null),
  ]);

  const s = summary?.summary || {};
  const windowSec = toNum(summary?.reportWindow?.requestedWindowSec, 0);
  const windowLabel = windowSec > 0 ? `${Math.round(windowSec / 60)}분` : "unknown";
  const fromMs = toNum(s?.windowFromMs, 0);
  const attempted = toNum(s?.orders?.attempted, 0);
  const successful = toNum(s?.orders?.successful, 0);
  const fillCount = toNum(s?.fills?.fillCount, 0);
  const rejected = Math.max(0, attempted - successful);
  const realizedPnlKrw = toNum(s?.realized?.realizedPnlKrw, 0);
  const winRatePct = toNum(s?.realized?.winRatePct, 0);

  const latestPrices = extractLatestPrices(state);
  const mtm = markToMarket(latestBalances(state), latestPrices);
  const rejectTopReasons = aggregateRejectReasons(state, fromMs, 3);

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
    realizedPnlKrw,
    winRatePct,
    mtm,
    rejectTopReasons,
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
      realizedPnlKrw,
      winRatePct,
      mtm,
      rejectTopReasons,
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
