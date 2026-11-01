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
  const render = () => { cursor = 0; tree = Card({ sessionId: "session-test" }); while (effects.length) effects.shift()(); return tree; };
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
  const runtime = await remoteRuntime(t, { connectionState: async () => ({ status: "disconnected", name: "" }), ...service }, false);
  const ui = hooks();
  const messages = [];
  await runtime.mount(runtime.client, { apply(ctx) {
    ctx.provide("conversation", {});
    ctx.provide("sessions", { scope(id) { assert.equal(id, "session-test"); return {
      get conversation() { throw new Error("Scoped property requires inject; use get()"); },
      get(name) { assert.equal(name, "conversation"); return { async send(text) { messages.push(text); } }; },
    }; } });
    ctx.provide("slots", {
    inject(_slot, register) { register(); }, register(_options, component) { ui.register(component); },
  }); } });
  const fiber = await runtime.mount(runtime.client, clientModule(new URL("../client.js", import.meta.url), { react: ui.React }));
  t.after(() => ui.unmount());
  return { ...runtime, ui, fiber, messages };
}

test("single icon connects through Host and sends guidance to its scoped conversation", async t => {
  const { ui, calls, messages } = await card(t, { connect: async () => ({ status: "connected", name: "test" }) });
  await ui.click("连接录音卡");
  assert.ok(ui.button("录音卡已连接，查看对话引导"));
  assert.equal(ui.input("设备地址"), undefined);
  assert.deepEqual(calls.filter(c => !c.endsWith("connectionState")), ["recorder/connect"]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Host 已确认蓝牙连接成功/);
  await ui.click("录音卡已连接，查看对话引导");
  assert.equal(messages.length, 2);
});

test("multiple devices are offered in conversation without claiming connection", async t => {
  const { ui, messages } = await card(t, { connect: async () => ({ status: "selection-required", name: "",
    devices: [{ address: "test-a", name: "A" }, { address: "test-b", name: "B" }] }) });
  await ui.click("连接录音卡");
  assert.equal(ui.button("录音卡已连接，查看对话引导"), undefined);
  assert.match(messages[0], /等我明确选择后/);
  assert.match(messages[0], /test-b/);
});

test("connect error stays visible and never produces success guidance", async t => {
  const { ui, messages } = await card(t, { connect: async () => { throw new TypeError("dependency missing"); } });
  await ui.click("连接录音卡");
  assert.match(ui.text(), /连接失败.*dependency missing/);
  assert.equal(messages.length, 0);
});

for (const exit of ["cancel", "component", "plugin"]) test(`connecting ${exit} aborts Host call without late UI updates`, async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let aborted = false;
  const { ui, calls, fiber, messages } = await card(t, { async connect(_address, { signal }) {
    ready();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    aborted = true; signal.throwIfAborted();
  } });
  const first = ui.button("连接录音卡").props.onClick();
  await started;
  assert.deepEqual(calls.filter(c => !c.endsWith("connectionState")), ["recorder/connect"]);
  if (exit === "cancel") await ui.click("取消连接录音卡");
  else if (exit === "component") ui.unmount();
  else await fiber.dispose();
  await first; await flush();
  assert.equal(aborted, true);
  assert.equal(ui.lateUpdates, 0);
  assert.equal(messages.length, 0);
});

test("actual Host drop clears green state and sends a single conversation notice", async t => {
  let state = { status: "disconnected", name: "" };
  const { ui, messages } = await card(t, {
    connect: async () => (state = { status: "connected", name: "test" }),
    connectionState: async () => state,
  });
  await ui.click("连接录音卡");
  state = { status: "disconnected", name: "" };
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.ok(ui.button("连接录音卡"));
  assert.equal(messages.length, 2);
  assert.match(messages[1], /连接已断开/);
});

test("idle cleanup warning is visible even when the card mounts after worker exit", async t => {
  const { ui } = await card(t, { connectionState: async () => ({ status: "cleanup-unconfirmed", name: "", message: "idle cleanup failed" }) });
  await flush(); await flush();
  assert.ok(ui.button("连接释放未确认，请检查设备"));
  assert.match(ui.text(), /设备连接释放未确认.*idle cleanup failed/);
  assert.equal(ui.button("录音卡已连接，查看对话引导"), undefined);
});
