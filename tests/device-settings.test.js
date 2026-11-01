import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceSettings } from "../runtime/device-settings.js";
import { createRecorderService } from "../runtime/host-cli.js";
import { remoteRuntime } from "./fixtures/remote-runtime.js";

async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), "recorder-settings-test-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

test("saved address immediately reaches CLI arguments and survives restart; empty overrides fallback", async t => {
  const dataDir = await directory(t);
  const config = { dataDir, deviceAddress: "test-fallback" };
  const settings = createDeviceSettings(dataDir, config);
  const calls = [];
  const cli = createRecorderService(config, { execute: async (_command, args) => {
    calls.push(args); return { code: 0, out: "", err: "" };
  } });
  t.after(() => cli.dispose());
  t.after(() => settings.dispose());
  assert.equal((await settings.getDevice()).source, "config");
  await settings.saveDevice(" test-saved ");
  await cli.status();
  assert.equal(calls[0][calls[0].indexOf("--address") + 1], "test-saved");
  const reloaded = createDeviceSettings(dataDir, { deviceAddress: "test-other-fallback" });
  t.after(() => reloaded.dispose());
  assert.deepEqual(await reloaded.getDevice(), { deviceAddress: "test-saved", source: "saved" });
  await reloaded.saveDevice("");
  const cleared = createDeviceSettings(dataDir, { deviceAddress: "test-fallback" });
  t.after(() => cleared.dispose());
  assert.deepEqual(await cleared.getDevice(), { deviceAddress: "", source: "saved" });
});

test("invalid, cancelled, or failed saves preserve the previous file and active address", async t => {
  const dataDir = await directory(t);
  const config = {};
  let fail = false;
  const settings = createDeviceSettings(dataDir, config, { ...fs, rename: async (...args) => {
    if (fail) throw Object.assign(new Error("test rename failure"), { code: "EACCES" });
    return fs.rename(...args);
  } });
  t.after(() => settings.dispose());
  await settings.saveDevice("test-original");
  for (const value of [null, "-option", "a\0b", "a b", "x".repeat(257)]) {
    assert.throws(() => settings.saveDevice(value), TypeError);
  }
  await assert.rejects(settings.saveDevice("test-cancelled", { signal: AbortSignal.abort() }), { name: "AbortError" });
  fail = true;
  await assert.rejects(settings.saveDevice("test-failed"), { name: "SettingsError" });
  assert.equal(config.deviceAddress, "test-original");
  assert.equal(JSON.parse(await fs.readFile(join(dataDir, "recorder-settings.json"))).deviceAddress, "test-original");
  assert.deepEqual(await fs.readdir(dataDir), ["recorder-settings.json"]);
});

test("corrupt settings block device use until explicitly replaced; serialized saves agree with disk", async t => {
  const dataDir = await directory(t);
  await fs.writeFile(join(dataDir, "recorder-settings.json"), "broken");
  const settings = createDeviceSettings(dataDir, {});
  await assert.rejects(settings.getDevice(), { name: "SettingsError" });
  await Promise.all([settings.saveDevice("test-one"), settings.saveDevice("test-two")]);
  assert.equal((await settings.getDevice()).deviceAddress, "test-two");
  assert.equal(JSON.parse(await fs.readFile(join(dataDir, "recorder-settings.json"))).deviceAddress, "test-two");
  await settings.dispose();
  await assert.rejects(settings.saveDevice("test-after-dispose"), { name: "AbortError" });
});

test("official Remote Gateway reads and persists device selection without BLE", async t => {
  const settings = createDeviceSettings(await directory(t), {});
  t.after(() => settings.dispose());
  const { client } = await remoteRuntime(t, settings);
  assert.equal((await client.remote.recorder.getDevice()).value.source, "none");
  assert.equal((await client.remote.recorder.saveDevice("test-from-client")).ok, true);
  assert.equal((await client.remote.recorder.getDevice()).value.deviceAddress, "test-from-client");
  const invalid = await client.remote.recorder.saveDevice("-bad");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "recorder/config-or-argument");
});
