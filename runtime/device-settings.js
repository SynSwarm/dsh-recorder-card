import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function deviceAddress(value) {
  if (typeof value !== "string") throw new TypeError("deviceAddress must be a string");
  const address = value.trim();
  if (address.length > 256 || /[\s\x00-\x1f\x7f]/u.test(address) || address.startsWith("-")) {
    throw new TypeError("Use the device identifier returned by scan (maximum 256 characters)");
  }
  return address;
}

// Small plugin-owned preference, outside installed sources. Atomic replacement
// preserves the previous selection on write failure. No BLE or Loader edits.
export function createDeviceSettings(directory, config, io = { mkdir, readFile, writeFile, rename, rm }) {
  const path = join(directory, "recorder-settings.json");
  let source = config.deviceAddress ? "config" : "none";
  let loadError;
  let tail = Promise.resolve();
  const lifetime = new AbortController();
  const ready = (async () => {
    try {
      const data = JSON.parse(await io.readFile(path, "utf8"));
      if (data.version !== 1) throw new Error("Unsupported settings version");
      config.deviceAddress = deviceAddress(data.deviceAddress);
      source = "saved";
    } catch (error) {
      if (error.code !== "ENOENT") loadError = error;
    }
  })();
  const snapshot = () => ({ deviceAddress: config.deviceAddress ?? "", source });
  const settingsError = error => Object.assign(new Error(
    "Recorder device settings could not be read or saved; check dataDir permissions or save the device address again.",
    { cause: error }), { name: "SettingsError" });
  return {
    async getDevice({ signal } = {}) {
      await ready;
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      if (loadError) throw settingsError(loadError);
      return snapshot();
    },
    saveDevice(value, { signal } = {}) {
      const address = deviceAddress(value);
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const save = async () => {
        await ready;
        combined.throwIfAborted();
        const temporary = join(directory, `.recorder-settings-${randomUUID()}.tmp`);
        try {
          await io.mkdir(directory, { recursive: true });
          await io.writeFile(temporary, JSON.stringify({ version: 1, deviceAddress: address }) + "\n",
            { flag: "wx", mode: 0o600, signal: combined });
          combined.throwIfAborted();
          await io.rename(temporary, path);
          // Rename is the commit point: update memory even if cancellation raced it.
          config.deviceAddress = address;
          source = "saved";
          loadError = undefined;
          return snapshot();
        } catch (error) {
          if (combined.aborted) throw combined.reason;
          throw settingsError(error);
        } finally { await io.rm(temporary, { force: true }); }
      };
      const result = tail.then(save);
      tail = result.catch(() => {});
      return result;
    },
    async dispose() { lifetime.abort(); await Promise.all([ready, tail]); },
  };
}
