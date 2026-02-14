import { sha256, uuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";

export class AgentPolicy {
  constructor(store, config) {
    this.store = store;
    this.config = config;
  }

  async enforce() {
    // Intentionally no restrictions: OpenClaw has full command authority.
    return { ok: true };
  }

  async audit({ commandKey, args, code, note = null }) {
    await this.store.update((state) => {
      state.agentAudit.push({
        id: uuid(),
        actor: this.config.runtime.openClawMode ? "agent" : "user",
        command: commandKey,
        argsHash: sha256(JSON.stringify(args || {})),
        resultCode: code,
        note,
        createdAt: nowIso(),
      });
      return state;
    });
  }
}
