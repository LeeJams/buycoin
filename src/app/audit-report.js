#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../config/env-loader.js";
import { loadConfig } from "../config/defaults.js";

function p95(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index];
}

function topErrors(rows, limit = 10) {
  const counts = new Map();
  for (const row of rows) {
    if (row.ok || !row.error) {
      continue;
    }
    const key = String(row.error);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function loadAuditRows(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizeByEndpoint(rows) {
  const map = new Map();

  for (const row of rows) {
    const method = String(row.method || "UNKNOWN").toUpperCase();
    const path = String(row.path || "unknown");
    const key = `${method} ${path}`;
    if (!map.has(key)) {
      map.set(key, {
        endpoint: key,
        count: 0,
        success: 0,
        fail: 0,
        avgLatencyMs: null,
        p95LatencyMs: null,
        minLatencyMs: null,
        maxLatencyMs: null,
        statuses: {},
      });
    }

    const agg = map.get(key);
    agg.count += 1;
    if (row.ok) {
      agg.success += 1;
    } else {
      agg.fail += 1;
    }

    const status = row.status ?? "null";
    agg.statuses[String(status)] = (agg.statuses[String(status)] || 0) + 1;
  }

  for (const [key, agg] of map.entries()) {
    const durationRows = rows.filter((row) => `${String(row.method || "UNKNOWN").toUpperCase()} ${String(row.path || "unknown")}` === key);
    const durations = durationRows
      .map((row) => Number(row.durationMs))
      .filter((value) => Number.isFinite(value) && value >= 0);

    if (durations.length > 0) {
      const total = durations.reduce((sum, value) => sum + value, 0);
      agg.avgLatencyMs = Number((total / durations.length).toFixed(3));
      agg.p95LatencyMs = p95(durations);
      agg.minLatencyMs = Math.min(...durations);
      agg.maxLatencyMs = Math.max(...durations);
    }
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

export async function generateAuditReport(filePath) {
  const rows = await loadAuditRows(filePath);
  const total = rows.length;
  const success = rows.filter((row) => row.ok).length;
  const fail = total - success;
  const durationValues = rows
    .map((row) => Number(row.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return {
    auditFile: filePath,
    totalRequests: total,
    successRequests: success,
    failedRequests: fail,
    successRate: total > 0 ? Number(((success / total) * 100).toFixed(3)) : null,
    avgLatencyMs: durationValues.length > 0
      ? Number((durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length).toFixed(3))
      : null,
    p95LatencyMs: p95(durationValues),
    topErrors: topErrors(rows, 10),
    endpoints: summarizeByEndpoint(rows),
  };
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");
  const config = loadConfig(process.env);
  const filePath = process.env.AUDIT_FILE || config.runtime.httpAuditFile;
  const report = await generateAuditReport(filePath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  });
}
