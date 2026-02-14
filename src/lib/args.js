import { invalidArg } from "./errors.js";

function isFlag(token) {
  return typeof token === "string" && token.startsWith("--");
}

export function parseArgv(argv) {
  const tokens = [...argv];
  const args = [];
  const flags = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isFlag(token)) {
      args.push(token);
      continue;
    }

    const key = token.replace(/^--/, "");
    const next = tokens[i + 1];
    if (!next || isFlag(next)) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { args, flags };
}

export function requireFlag(flags, key) {
  if (!(key in flags)) {
    throw invalidArg(`Missing required option --${key}`, {
      flag: key,
      reason: "missing_required_option",
    });
  }

  return flags[key];
}

export function numberFlag(flags, key, fallback = null) {
  if (!(key in flags)) {
    return fallback;
  }

  const parsed = Number(flags[key]);
  if (!Number.isFinite(parsed)) {
    throw invalidArg(`Invalid numeric option --${key}: ${flags[key]}`, {
      flag: key,
      value: flags[key],
      reason: "invalid_number",
    });
  }

  return parsed;
}
