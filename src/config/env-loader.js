import fs from "node:fs/promises";
import path from "node:path";

function parseValue(raw) {
  if (raw === undefined || raw === null) {
    return "";
  }

  let value = String(raw).trim();
  if (!value) {
    return "";
  }

  const isDoubleQuoted = value.startsWith("\"") && value.endsWith("\"");
  const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) {
    value = value.slice(1, -1);
  } else {
    // Remove trailing inline comment for unquoted values.
    const hashIndex = value.indexOf(" #");
    if (hashIndex >= 0) {
      value = value.slice(0, hashIndex).trim();
    }
  }

  if (isDoubleQuoted) {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  return value;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf("=");
  if (eq <= 0) {
    return null;
  }

  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const rawValue = body.slice(eq + 1);
  return { key, value: parseValue(rawValue) };
}

export async function loadEnvFile(filePath = ".env", { override = false } = {}) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  let raw;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { loaded: false, path: resolved, count: 0 };
    }
    throw error;
  }

  const entries = raw
    .split(/\r?\n/)
    .map(parseLine)
    .filter(Boolean);

  let count = 0;
  for (const entry of entries) {
    if (!override && Object.prototype.hasOwnProperty.call(process.env, entry.key)) {
      continue;
    }

    process.env[entry.key] = entry.value;
    count += 1;
  }

  return { loaded: true, path: resolved, count };
}
