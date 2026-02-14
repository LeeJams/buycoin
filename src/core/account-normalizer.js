function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAccountRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (payload?.data && typeof payload.data === "object") {
    return Object.entries(payload.data).map(([currency, row]) => ({
      ...(row && typeof row === "object" ? row : {}),
      currency,
    }));
  }

  return [];
}

export function normalizeAccounts(payload) {
  const rows = normalizeAccountRows(payload);
  return rows
    .map((row) => {
      const currency = String(row.currency || row.asset || "").toUpperCase();
      if (!currency) {
        return null;
      }

      const unitCurrency = String(row.unit_currency || row.unitCurrency || "KRW").toUpperCase();
      const balance = asNumber(row.balance ?? row.available ?? row.total_balance);
      const locked = asNumber(row.locked ?? row.in_use ?? row.hold_balance ?? 0);
      const avgBuyPrice = asNumber(row.avg_buy_price ?? row.avgBuyPrice);

      return {
        currency,
        unitCurrency,
        symbol: `${currency}_${unitCurrency}`,
        balance: balance ?? 0,
        locked: locked ?? 0,
        avgBuyPrice,
        raw: row,
      };
    })
    .filter(Boolean);
}
