import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/defaults.js";
import { StateStore } from "../src/core/store.js";

export async function createTempStore() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "trader-test-"));
  const config = loadConfig({
    TRADER_STATE_FILE: path.join(baseDir, "state.json"),
    TRADER_PAPER_MODE: "true",
  });
  const store = new StateStore(config.runtime.stateFile);
  await store.init();
  return { store, config, baseDir };
}
