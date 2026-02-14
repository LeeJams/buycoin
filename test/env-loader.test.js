import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "../src/config/env-loader.js";

test("loadEnvFile loads keys from .env without overriding existing process env", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "env-loader-"));
  const envPath = path.join(baseDir, ".env");
  await fs.writeFile(
    envPath,
    [
      "BITHUMB_ACCESS_KEY=from_env_file",
      "BITHUMB_SECRET_KEY='secret value'",
      "OPENCLAW_AGENT=true",
      "RISK_MAX_CONCURRENT_ORDERS=7",
      "",
    ].join("\n"),
    "utf8",
  );

  const oldAccessKey = process.env.BITHUMB_ACCESS_KEY;
  const oldSecretKey = process.env.BITHUMB_SECRET_KEY;
  const oldAgent = process.env.OPENCLAW_AGENT;
  const oldConcurrent = process.env.RISK_MAX_CONCURRENT_ORDERS;
  process.env.BITHUMB_ACCESS_KEY = "already_set";

  const result = await loadEnvFile(envPath);
  assert.equal(result.loaded, true);
  assert.equal(result.count >= 3, true);

  assert.equal(process.env.BITHUMB_ACCESS_KEY, "already_set");
  assert.equal(process.env.BITHUMB_SECRET_KEY, "secret value");
  assert.equal(process.env.OPENCLAW_AGENT, "true");
  assert.equal(process.env.RISK_MAX_CONCURRENT_ORDERS, "7");

  if (oldAccessKey === undefined) delete process.env.BITHUMB_ACCESS_KEY;
  else process.env.BITHUMB_ACCESS_KEY = oldAccessKey;

  if (oldSecretKey === undefined) delete process.env.BITHUMB_SECRET_KEY;
  else process.env.BITHUMB_SECRET_KEY = oldSecretKey;

  if (oldAgent === undefined) delete process.env.OPENCLAW_AGENT;
  else process.env.OPENCLAW_AGENT = oldAgent;

  if (oldConcurrent === undefined) delete process.env.RISK_MAX_CONCURRENT_ORDERS;
  else process.env.RISK_MAX_CONCURRENT_ORDERS = oldConcurrent;
});
