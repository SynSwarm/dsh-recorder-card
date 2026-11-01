import test from "node:test";
import assert from "node:assert/strict";
import { clientModule, remoteRuntime } from "./fixtures/remote-runtime.js";

const transcriptResult = { status: "succeeded", provider: "dsh", recognizer: "test", path: "corpus.md", audioPath: "saved-test.wav", audioSha256: "a".repeat(64), reused: false };

const flush = () => new Promise(resolve => setImmediate(resolve));
function hooks() {
  let cursor = 0, Card, tree, alive = true, lateUpdates = 0;
  const values = [], effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], value => { if (!alive) lateUpdates++; values[slot] = value; }];
    },
    useRef(initial) { return values[cursor++] ??= { current: initial }; },
    useEffect(fn) { const slot = cursor++; if (!(slot in values)) effects.push(() => { values[slot] = { cleanup: fn() }; }); },
  };
  const render = () => { cursor = 0; tree = Card(); while (effects.length) effects.shift()(); return tree; };
  const text = (...args) => { const node = args.length ? args[0] : render(); return !node || typeof node !== "object" ? String(node ?? "") : node.children.map(child => text(child)).join(" "); };
  const nodes = (...args) => { const node = args.length ? args[0] : render(); return !node || typeof node !== "object" ? [] : [node, ...node.children.flatMap(child => nodes(child))]; };
  return { React, text,
    register(component) { Card = component; render(); },
    button(label) { return nodes().find(n => n.type === "button" && (n.props["aria-label"] ?? text(n)) === label); },
    input(label) { return nodes().find(n => n.type === "input" && n.props["aria-label"] === label); },
    async click(label) { const button = this.button(label); assert.ok(button, label); if (!button.props.disabled) await button.props.onClick(); render(); },
    unmount() { alive = false; for (const value of values) if (typeof value?.cleanup === "function") value.cleanup(); },
    get lateUpdates() { return lateUpdates; },
  };
}
const success = { code: 0, out: "test device", err: "" };
async function card(t, service) {
  const runtime = await remoteRuntime(t, service, false);
  const ui = hooks();
  await runtime.mount(runtime.client, { apply(ctx) { ctx.provide("slots", {
    inject(_slot, register) { register(); }, register(_options, component) { ui.register(component); },
  }); } });
  const fiber = await runtime.mount(runtime.client, clientModule(new URL("../client.js", import.meta.url), { react: ui.React }));
  t.after(() => ui.unmount());
  return { ...runtime, ui, fiber };
}

test("icon uses Host Remote without browser BLE; operation errors remain visible", async t => {
  const { ui, calls } = await card(t, { scan: async () => success, status: async () => { throw new TypeError("deviceAddress required"); } });
  assert.deepEqual(calls, []);
  await ui.click("扫描录音卡");
  assert.deepEqual(calls, ["recorder/scan"]);
  assert.match(ui.text(), /test device/);
  assert.match(ui.text(), /设备地址/);
  await ui.click("读取状态");
  assert.match(ui.text(), /recorder\/config-or-argument.*deviceAddress required/);
});

test("device settings UI loads, saves and displays failure without claiming success", async t => {
  let saved = "test-initial";
  const { ui, calls } = await card(t, {
    getDevice: async () => ({ deviceAddress: saved, source: "saved" }),
    saveDevice: async address => {
      if (address === "test-fail") throw Object.assign(new Error("Cannot save settings"), { name: "SettingsError" });
      saved = address; return { deviceAddress: saved, source: "saved" };
    },
  });
  await ui.click("设置设备");
  assert.equal(ui.input("设备地址").props.value, "test-initial");
  ui.input("设备地址").props.onChange({ target: { value: "test-new" } });
  await ui.click("保存设备地址");
  assert.equal(saved, "test-new");
  assert.match(ui.text(), /已保存并生效/);
  ui.input("设备地址").props.onChange({ target: { value: "test-fail" } });
  await ui.click("保存设备地址");
  assert.match(ui.text(), /recorder\/settings-failed/);
  assert.doesNotMatch(ui.text(), /已保存并生效/);
  assert.equal(saved, "test-new");
  assert.deepEqual(calls, ["recorder/getDevice", "recorder/saveDevice", "recorder/saveDevice"]);
});

for (const exit of ["cancel", "component", "plugin"]) test(`busy UI rejects rapid clicks and ${exit} aborts the Host call`, async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let aborted = false;
  const { ui, calls, fiber } = await card(t, { async scan({ signal }) {
    ready();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    aborted = true; signal.throwIfAborted();
  } });
  const click = ui.button("扫描录音卡").props.onClick;
  const first = click();
  await click();
  await started;
  assert.deepEqual(calls, ["recorder/scan"]);
  assert.equal(ui.button("读取状态").props.disabled, true);
  if (exit === "cancel") await ui.click("取消");
  else if (exit === "component") ui.unmount();
  else await fiber.dispose();
  await first; await flush();
  assert.equal(aborted, true);
  assert.equal(ui.lateUpdates, 0);
  if (exit === "cancel") assert.match(ui.text(), /已取消.*连接释放未确认/);
});

test("partial import displays both failures and retries only transcription of the saved audio", async t => {
  let imports = 0;
  const { ui, calls } = await card(t, {
    scan: async () => success,
    async importFirst(_dir, transcribe) {
      imports++; assert.equal(transcribe, true);
      return { status: "partial", import: { status: "succeeded", path: "saved-test.wav", bytes: 48, sha256: "a".repeat(64),
        integrity: { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 } },
        transcription: { status: "failed", error: { code: "asr", message: "ASR offline" } },
        cleanup: { status: "unconfirmed", errors: [{ code: "disconnect", message: "release unconfirmed" }] } };
    },
    async transcribe(file, options) { assert.equal(file, "saved-test.wav"); assert.equal(options.force, false); return transcriptResult; },
  });
  await ui.click("扫描录音卡");
  await ui.click("导入首条并转写");
  assert.match(ui.text(), /ASR offline/);
  assert.match(ui.text(), /release unconfirmed/);
  await ui.click("重试已保存音频的转写");
  assert.equal(imports, 1);
  assert.equal(calls.at(-1), "recorder/transcribe");
  assert.equal(ui.button("重试已保存音频的转写"), undefined);
  assert.match(ui.text(), /导入时连接释放未确认.*release unconfirmed/);
});
