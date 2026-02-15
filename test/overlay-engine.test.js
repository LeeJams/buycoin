import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OverlayEngine } from "../src/engine/overlay-engine.js";

async function makeConfig() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-test-"));
  return {
    runtime: {
      overlayFile: path.join(baseDir, "overlay.json"),
    },
    overlay: {
      enabled: true,
      timeoutMs: 500,
      defaultMultiplier: 1,
      fallbackMultiplier: 1,
      minMultiplier: 0.2,
      maxMultiplier: 1.5,
      maxStalenessSec: 600,
    },
  };
}

test("overlay engine returns default when file is missing", async () => {
  const config = await makeConfig();
  const engine = new OverlayEngine(config);

  const result = await engine.readCurrent();
  assert.equal(result.multiplier, 1);
  assert.equal(result.source, "overlay_default");
});

test("overlay engine reads explicit multiplier and clamps range", async () => {
  const config = await makeConfig();
  const engine = new OverlayEngine(config);

  await engine.setCurrent({ multiplier: 10, regime: "risk_on" });
  const result = await engine.readCurrent();
  assert.equal(result.multiplier, 1.5);
  assert.equal(result.source, "overlay_multiplier");
  assert.equal(result.regime, "risk_on");
});

test("overlay engine falls back when stale", async () => {
  const config = await makeConfig();
  config.overlay.maxStalenessSec = 1;
  const engine = new OverlayEngine(config);

  await engine.setCurrent({ multiplier: 0.6 });
  const stalePayload = {
    updatedAt: new Date(Date.now() - 10_000).toISOString(),
    multiplier: 0.6,
    score: null,
    regime: "risk_off",
  };
  await fs.writeFile(config.runtime.overlayFile, JSON.stringify(stalePayload), "utf8");

  const result = await engine.readCurrent();
  assert.equal(result.source, "overlay_stale_fallback");
  assert.equal(result.multiplier, 1);
});
