#!/usr/bin/env node
import { loadConfig } from "../config/defaults.js";
import { loadEnvFile } from "../config/env-loader.js";
import { EXIT_CODES } from "../config/exit-codes.js";
import { TraderService } from "../core/trader-service.js";
import { numberFlag, parseArgv, requireFlag } from "../lib/args.js";
import { isCliError, normalizeErrorPayload } from "../lib/errors.js";
import { printResult } from "../lib/output.js";

function commandKeyFrom(args) {
  const [group, action] = args;
  if (!group) {
    return "help";
  }

  if (group === "status") {
    return "status";
  }
  if (group === "health") {
    return "health";
  }
  if (group === "markets") {
    return "markets";
  }
  if (group === "candles") {
    return "candles";
  }
  if (group === "paper") {
    return `paper:${action || "unknown"}`;
  }
  if (group === "strategy") {
    return `strategy:${action || "unknown"}`;
  }
  if (group === "order") {
    return `order:${action || "unknown"}`;
  }
  if (group === "account") {
    return `account:${action || "unknown"}`;
  }
  if (group === "kill-switch") {
    return `kill-switch:${action || "unknown"}`;
  }
  if (group === "logs") {
    return `logs:${action || "unknown"}`;
  }
  if (group === "reconcile") {
    return `reconcile:${action || "unknown"}`;
  }

  return "unknown";
}

function helpText() {
  return `
Usage:
  trader status [--json]
  trader health [--check-exchange] [--strict] [--json]
  trader markets --symbol BTC_KRW [--json]
  trader candles --symbol BTC_KRW [--interval 1m|3m|5m|10m|15m|30m|60m|240m|day|week|month] [--count 200] [--to 2026-02-13T15:00:00+09:00] [--json]
  trader paper on|off [--reason TEXT] [--json]
  trader strategy run --name grid [--symbol BTC_KRW] [--dry-run] [--budget 100000] [--json]
  trader strategy stop [--name grid] [--json]
  trader order pick [--side buy] [--select-mode momentum|volume] [--candidates BTC_KRW,ETH_KRW] [--json]
  trader order chance [--symbol BTC_KRW] [--json]
  trader order place [--symbol BTC_KRW|--auto-symbol] --side buy --type limit [--price 100] --amount 5000 [--select-mode momentum|volume] [--candidates BTC_KRW,ETH_KRW] [--client-order-key KEY] [--confirm YES] [--json]
  trader order unknown --action force-close|mark-rejected [--id <orderId>|--client-order-key KEY|--all] [--reason TEXT] [--json]
  trader order cancel --id <orderId|uuid> [--symbol BTC_KRW] [--json]
  trader order list [--symbol BTC_KRW] [--uuids id1,id2] [--state wait|watch|done|cancel] [--states wait,done] [--page 1] [--limit 100] [--order-by asc|desc] [--json]
  trader order get --id <orderId|uuid> [--symbol BTC_KRW] [--json]
  trader account list [--json]
  trader kill-switch on|off [--reason TEXT] [--json]
  trader logs tail [--json]
  trader reconcile run [--json]
`;
}

function csvFlag(flags, key) {
  if (!(key in flags)) {
    return null;
  }

  return String(flags[key])
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function executeCommand(service, parsed) {
  const { args, flags } = parsed;
  const [group, action] = args;
  const command = [group, action].filter(Boolean).join(" ");
  const commandKey = commandKeyFrom(args);
  const json = Boolean(flags.json);

  const policy = await service.enforcePolicy({
    commandKey,
    jsonRequested: json,
    args: { ...flags, command: args },
  });
  if (!policy.ok) {
    return policy;
  }

  if (!group || group === "help" || group === "--help") {
    return { ok: true, code: EXIT_CODES.OK, data: helpText() };
  }

  if (group === "status") {
    return service.status();
  }

  if (group === "health") {
    return service.health({
      checkExchange: Boolean(flags["check-exchange"]),
      strict: Boolean(flags.strict),
    });
  }

  if (group === "markets") {
    const symbol = flags.symbol || service.config.trading.defaultSymbol;
    return service.fetchMarket(symbol);
  }

  if (group === "candles") {
    const symbol = flags.symbol || service.config.trading.defaultSymbol;
    return service.fetchCandles({
      symbol,
      interval: flags.interval || "1m",
      count: numberFlag(flags, "count", 200),
      to: flags.to || null,
    });
  }

  if (group === "paper") {
    if (action === "on") {
      return service.setPaperMode(true, flags.reason || null);
    }

    if (action === "off") {
      return service.setPaperMode(false, flags.reason || null);
    }
  }

  if (group === "strategy" && action === "run") {
    return service.runStrategy({
      name: flags.name || "grid",
      symbol: flags.symbol || service.config.trading.defaultSymbol,
      dryRun: Boolean(flags["dry-run"]),
      budget: flags.budget,
    });
  }

  if (group === "strategy" && action === "stop") {
    return service.stopStrategy(flags.name || null);
  }

  if (group === "order" && action === "place") {
    if (
      !service.paperMode() &&
      !service.config.runtime.openClawMode &&
      String(flags.confirm || "").toUpperCase() !== "YES"
    ) {
      return {
        ok: false,
        code: EXIT_CODES.INVALID_ARGS,
        error: {
          message: "Live direct order requires --confirm YES",
        },
      };
    }

    return service.placeOrderDirect({
      symbol: flags.symbol || null,
      autoSymbol: Boolean(flags["auto-symbol"]),
      side: requireFlag(flags, "side"),
      type: flags.type || "limit",
      price: numberFlag(flags, "price", null),
      amount: numberFlag(flags, "amount"),
      selectMode: flags["select-mode"] || null,
      candidates: csvFlag(flags, "candidates"),
      clientOrderKey: flags["client-order-key"] || null,
      strategy: flags.strategy || "manual",
      reason: flags.reason || "direct order",
    });
  }

  if (group === "order" && action === "pick") {
    return service.pickSymbol({
      side: flags.side || "buy",
      selectMode: flags["select-mode"] || null,
      candidates: csvFlag(flags, "candidates"),
    });
  }

  if (group === "order" && action === "chance") {
    return service.getOrderChance(flags.symbol || service.config.trading.defaultSymbol);
  }

  if (group === "order" && action === "cancel") {
    return service.cancelOrder(requireFlag(flags, "id"), {
      symbol: flags.symbol || null,
    });
  }

  if (group === "order" && action === "unknown") {
    return service.resolveUnknownSubmitOrders({
      action: flags.action || "force-close",
      orderId: flags.id || null,
      clientOrderKey: flags["client-order-key"] || null,
      all: Boolean(flags.all),
      reason: flags.reason || null,
    });
  }

  if (group === "order" && action === "list") {
    return service.listOrders({
      symbol: flags.symbol || null,
      uuids: csvFlag(flags, "uuids"),
      state: flags.state || null,
      states: csvFlag(flags, "states"),
      page: numberFlag(flags, "page", 1),
      limit: numberFlag(flags, "limit", 100),
      orderBy: flags["order-by"] || "desc",
    });
  }

  if (group === "order" && action === "get") {
    return service.getOrder(requireFlag(flags, "id"), {
      symbol: flags.symbol || null,
    });
  }

  if (group === "account" && action === "list") {
    return service.listAccounts();
  }

  if (group === "kill-switch") {
    if (action === "on") {
      return service.setKillSwitch(true, flags.reason || "manual kill-switch on");
    }
    if (action === "off") {
      return service.setKillSwitch(false, flags.reason || "manual kill-switch off");
    }
  }

  if (group === "logs" && action === "tail") {
    return service.tailLogs();
  }

  if (group === "reconcile" && action === "run") {
    return service.reconcile();
  }

  return {
    ok: false,
    code: EXIT_CODES.INVALID_ARGS,
    error: { message: `Unknown command: ${command || group}` },
  };
}

async function main() {
  await loadEnvFile(process.env.TRADER_ENV_FILE || ".env");

  const parsed = parseArgv(process.argv.slice(2));
  const json = Boolean(parsed.flags.json);
  const config = loadConfig(process.env);
  const service = new TraderService(config);
  await service.init();

  let result;
  const command = parsed.args.join(" ").trim() || "help";

  try {
    result = await executeCommand(service, parsed);
  } catch (error) {
    if (isCliError(error)) {
      result = {
        ok: false,
        code: error.code,
        error: normalizeErrorPayload(error, error.code),
      };
    } else {
      result = {
        ok: false,
        code: EXIT_CODES.INTERNAL_ERROR,
        error: normalizeErrorPayload(error, EXIT_CODES.INTERNAL_ERROR),
      };
    }
  }

  try {
    await service.agentPolicy.audit({
      commandKey: commandKeyFrom(parsed.args),
      args: { ...parsed.flags, command: parsed.args },
      code: result.code,
      note: result.ok ? null : result.error?.message || null,
    });
  } catch {
    // Avoid breaking command output if audit persistence fails.
  }

  printResult({
    json,
    command,
    status: result.ok ? "ok" : "error",
    code: result.code,
    data: result.ok ? result.data : null,
    error: result.ok ? null : result.error,
  });
  process.exit(result.code);
}

main();
