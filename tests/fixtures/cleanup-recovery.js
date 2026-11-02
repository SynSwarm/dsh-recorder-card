import assert from "node:assert/strict";
import { createRecorderService } from "../../runtime/host-cli.js";

// End tests that intentionally poison the shared BLE queue with a confirmed,
// simulated reconnect. No real Python process or Bluetooth access is involved.
export async function recoverCleanupNotice() {
  const recovery = createRecorderService({}, { openConnection: () => {
    let close;
    return { closed: new Promise(resolve => { close = resolve; }),
      request: async () => ({ status: "connected", name: "test" }),
      dispose: async () => close() };
  } });
  try {
    try { await recovery.connect(); }
    catch (error) {
      assert.equal(error.name, "CleanupError");
      await recovery.connect();
    }
  } finally { await recovery.dispose(); }
}
