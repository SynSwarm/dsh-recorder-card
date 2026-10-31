import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { getEventListeners } from "node:events";
import { buildFrame, FrameParser, UUIDS } from "../vendor/recorder-protocol.js";

function notification(payload) {
  const frame = buildFrame(payload);
  const buffer = new Uint8Array(frame.length + 9);
  buffer.set(frame, 4);
  return new DataView(buffer.buffer, 4, frame.length);
}

function filePayload(name) {
  const body = new Uint8Array(34);
  body.set([2, 1, 0, 0, 0, 1]);
  body.set(new TextEncoder().encode(name), 14);
  return body;
}

function deviceMock({ writeGate, withoutResponse = true } = {}) {
  const device = new EventTarget();
  const notify = new EventTarget();
  const writes = [];
  let writeError = null;
  let activeWrites = 0;
  let overlaps = 0;
  async function writeFrame(frame) {
    if (activeWrites) {
      overlaps++;
      throw new Error("GATT operation already in progress");
    }
    activeWrites++;
    try {
      if (writeError) throw writeError;
      const payload = Array.from(frame.slice(6));
      writes.push(payload);
      await writeGate?.(payload);
    } finally {
      activeWrites--;
    }
  }
  const write = {
    properties: { writeWithoutResponse: withoutResponse },
    writeValueWithoutResponse: writeFrame,
    writeValue: writeFrame,
  };
  notify.startNotifications = async () => notify;
  const server = {
    connected: false,
    async connect() { server.connected = true; return server; },
    async getPrimaryService() {
      return { async getCharacteristic(uuid) { return uuid === UUIDS.write ? write : notify; } };
    },
    disconnect() {
      if (!server.connected) return;
      server.connected = false;
      device.dispatchEvent(new Event("gattserverdisconnected"));
    },
  };
  device.gatt = server;
  return {
    device, server, notify, writes,
    get overlaps() { return overlaps; },
    failWrites(error) { writeError = error; },
    emit(payload) {
      notify.value = notification(payload);
      notify.dispatchEvent(new Event("characteristicvaluechanged"));
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Flush promise continuations without advancing the component's fake timers.
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

// A small hook/element harness executes the actual registered Card, without
// installing React or a DSH runtime. It does not substitute for browser tests.
function mountCard(devices) {
  let cursor = 0;
  let Card;
  let tree;
  let now = 0;
  let timerId = 0;
  let mounted = true;
  let lateUpdates = 0;
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) }; },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], (value) => {
        if (!mounted) lateUpdates++;
        hooks[slot] = typeof value === "function" ? value(hooks[slot]) : value;
      }];
    },
    useRef(initial) {
      const slot = cursor++;
      return hooks[slot] ??= { current: initial };
    },
    useCallback(fn, deps) {
      const slot = cursor++;
      if (!sameDeps(hooks[slot]?.deps, deps)) hooks[slot] = { fn, deps };
      return hooks[slot].fn;
    },
    useEffect(fn, deps) {
      const slot = cursor++;
      if (!sameDeps(hooks[slot]?.deps, deps)) effects.push(() => {
        hooks[slot]?.cleanup?.();
        hooks[slot] = { deps, cleanup: fn() };
      });
    },
  };
  vm.runInNewContext(readFileSync(new URL("../client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(module) {
      module.factory(() => React).apply({ slots: {
        inject(_name, register) { register(); },
        register(_options, component) { Card = component; },
      } });
    } } },
    navigator: { bluetooth: { async requestDevice() { return devices.shift().device; } } },
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, AbortController,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, time: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function render() {
    cursor = 0;
    tree = Card();
    while (effects.length) effects.shift()();
    return tree;
  }
  function nodes(node = render()) {
    if (!node || typeof node !== "object") return [];
    return [node, ...node.children.flatMap((child) => nodes(child))];
  }
  function text(node = render()) {
    if (node == null) return "";
    if (typeof node !== "object") return String(node);
    return node.children.map((child) => text(child)).join(" ");
  }
  render();
  return {
    text,
    button(label) { return nodes().find((node) => node.type === "button" && text(node) === label); },
    async click(label) {
      const button = this.button(label);
      assert.ok(button, `Missing button: ${label}`);
      if (!button.props.disabled) await button.props.onClick();
      render();
    },
    timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.time <= now && timers.delete(id)) timer.fn();
      }
      render();
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) hook?.cleanup?.();
    },
    get lateUpdates() { return lateUpdates; },
  };
}

test("protocol accepts offset DataView notifications and fragmented views", () => {
  const view = notification([0, 4, 73]);
  assert.equal(new FrameParser().push(view)[0]?.params[0], 73);
  const parser = new FrameParser();
  assert.equal(parser.push(new DataView(view.buffer, view.byteOffset, 5)).length, 0);
  assert.equal(parser.push(new DataView(view.buffer, view.byteOffset + 5, view.byteLength - 5))[0]?.params[0], 73);
  assert.equal(new FrameParser().push(buildFrame([0, 4, 73])).length, 1);
  const framed = buildFrame([0, 4, 73]);
  assert.equal(new FrameParser().push(framed.buffer).length, 1);
  const padded = new Uint8Array(framed.length + 8);
  padded.set(framed, 3);
  assert.equal(new FrameParser().push(padded.subarray(3, 3 + framed.length)).length, 1);
});

test("browser DataView notifications update battery, recording state, and file list", async () => {
  const card = deviceMock();
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  card.emit([0, 4, 73]);
  card.emit([3, 20, 1]);
  assert.match(ui.text(), /电量 73%/);
  assert.match(ui.text(), /录音中/);
  await ui.click("读取文件列表");
  card.emit(filePayload("first.wav"));
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /first.wav/);
  assert.match(ui.text(), /列表读取完成/);
  assert.doesNotMatch(ui.text(), /超时|不完整/);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});

test("duplicate list clicks cannot replace an active request or leave extra timers", async () => {
  const card = deviceMock();
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  // Use the same handler twice to model clicks before a React rerender.
  const readList = ui.button("读取文件列表").props.onClick;
  await readList();
  ui.advance(500);
  await readList();
  assert.equal(card.writes.filter((p) => p[0] === 2 && p[1] === 0).length, 1);
  assert.equal(ui.timers.size, 1);
  card.emit([2, 18, 0]);
  ui.advance(2000);
  assert.equal(ui.timers.size, 0);
  await ui.click("读取文件列表");
  assert.equal(ui.timers.size, 1);
  ui.unmount();
});

for (const unexpected of [false, true]) {
  test(`${unexpected ? "unexpected" : "manual"} disconnect clears device state and allows another card`, async () => {
    const first = deviceMock();
    const second = deviceMock();
    const ui = mountCard([first, second]);
    await ui.click("连接录音卡");
    first.emit([0, 4, 73]);
    await ui.click("读取文件列表");
    first.emit(filePayload("old.wav"));
    first.emit([2, 18, 0]);
    assert.match(ui.text(), /old.wav/);
    await ui.click("读取文件列表");
    if (unexpected) first.server.disconnect();
    else await ui.click("断开");
    assert.ok(ui.button("连接录音卡"));
    assert.equal(ui.timers.size, 0);
    assert.equal(getEventListeners(first.notify, "characteristicvaluechanged").length, 0);
    assert.equal(getEventListeners(first.device, "gattserverdisconnected").length, 0);
    await ui.click("连接录音卡");
    first.emit([0, 4, 99]);
    assert.doesNotMatch(ui.text(), /old.wav|73%|99%/);
    second.emit([0, 4, 42]);
    assert.match(ui.text(), /42%/);
    ui.advance(5000);
    ui.unmount();
  });
}

test("unmount cancels pending list timer and notification updates", async () => {
  const card = deviceMock();
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  ui.unmount();
  assert.equal(ui.timers.size, 0);
  assert.equal(card.server.connected, false);
  card.emit([0, 4, 99]);
  assert.equal(ui.lateUpdates, 0);
});

test("a finished request's stale timeout cannot finish the next list", async () => {
  const card = deviceMock();
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  const oldTimeout = [...ui.timers.values()][0].fn;
  card.emit([2, 18, 0]);
  await ui.click("读取文件列表");
  card.emit(filePayload("new.wav"));
  oldTimeout(); // Simulate a callback already queued before clearTimeout.
  assert.equal(ui.timers.size, 1);
  assert.equal(ui.button("读取文件列表").props.disabled, true);
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /new.wav/);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});

test("list idle timeout is extended by incoming frames and marks partial results", async () => {
  const card = deviceMock();
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  ui.advance(1000);
  card.emit(filePayload("one.wav"));
  ui.advance(1000);
  assert.equal(ui.button("读取文件列表").props.disabled, true);
  card.emit(filePayload("two.wav"));
  ui.advance(1200);
  assert.match(ui.text(), /one.wav/);
  assert.match(ui.text(), /two.wav/);
  assert.match(ui.text(), /可能不完整/);
  assert.equal(ui.timers.size, 0);
  ui.unmount();
});

test("list write failure requires reconnect before retrying an uncertain request", async () => {
  const card = deviceMock();
  const ui = mountCard([card, card]);
  await ui.click("连接录音卡");
  card.failWrites(new Error("write failed"));
  await ui.click("读取文件列表");
  assert.equal(ui.timers.size, 0);
  assert.match(ui.text(), /write failed/);
  assert.equal(ui.button("读取文件列表").props.disabled, true);
  card.emit([2, 18, 0]);
  assert.doesNotMatch(ui.text(), /列表读取完成/);
  card.failWrites(null);
  await ui.click("断开");
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  card.emit(filePayload("retry.wav"));
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /retry.wav/);
  ui.unmount();
});

test("notification setup failure closes the connection and removes listeners", async () => {
  const card = deviceMock();
  card.notify.startNotifications = async () => { throw new Error("notify failed"); };
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  assert.ok(ui.button("连接录音卡"));
  assert.match(ui.text(), /notify failed/);
  assert.equal(card.server.connected, false);
  assert.equal(getEventListeners(card.notify, "characteristicvaluechanged").length, 0);
  assert.equal(getEventListeners(card.device, "gattserverdisconnected").length, 0);
  ui.unmount();
});

test("a connection resolving after unmount is closed without updating state", async () => {
  const card = deviceMock();
  let resolveConnection;
  let connectionStarted;
  const started = new Promise((resolve) => { connectionStarted = resolve; });
  card.server.connect = () => new Promise((resolve) => {
    resolveConnection = () => { card.server.connected = true; resolve(card.server); };
    connectionStarted();
  });
  const ui = mountCard([card]);
  const connecting = ui.button("连接录音卡").props.onClick();
  await started;
  ui.unmount();
  resolveConnection();
  await connecting;
  assert.equal(card.server.connected, false);
  assert.equal(getEventListeners(card.notify, "characteristicvaluechanged").length, 0);
  assert.equal(getEventListeners(card.device, "gattserverdisconnected").length, 0);
  assert.equal(ui.lateUpdates, 0);
});

test("unmount during notification setup immediately releases the device", async () => {
  const card = deviceMock();
  let finishSetup;
  let setupStarted;
  const started = new Promise((resolve) => { setupStarted = resolve; });
  card.notify.startNotifications = () => new Promise((resolve) => {
    finishSetup = resolve;
    setupStarted();
  });
  const ui = mountCard([card]);
  const connecting = ui.button("连接录音卡").props.onClick();
  await started;
  assert.equal(card.server.connected, true);
  ui.unmount();
  assert.equal(card.server.connected, false);
  assert.equal(getEventListeners(card.notify, "characteristicvaluechanged").length, 0);
  assert.equal(getEventListeners(card.device, "gattserverdisconnected").length, 0);
  finishSetup();
  await connecting;
  assert.equal(ui.lateUpdates, 0);
});

test("no-response list timeout requires reconnect before confirming an empty list", async () => {
  const card = deviceMock();
  const ui = mountCard([card, card]);
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  ui.advance(1200);
  assert.match(ui.text(), /超时/);
  assert.match(ui.text(), /未收到/);
  assert.doesNotMatch(ui.text(), /列表读取完成/);
  assert.equal(ui.button("读取文件列表").props.disabled, true);
  // A late completion must not silently change the timeout into success.
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /超时/);
  await ui.click("断开");
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /列表读取完成.*0/);
  assert.doesNotMatch(ui.text(), /超时|不完整/);
  ui.unmount();
});

test("partial timeout remains marked incomplete while other controls are used", async () => {
  const card = deviceMock();
  const ui = mountCard([card, card]);
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  card.emit(filePayload("partial.wav"));
  ui.advance(1200);
  assert.match(ui.text(), /partial.wav/);
  assert.match(ui.text(), /超时.*可能不完整/);
  await ui.click("导入");
  await ui.click("刷新");
  assert.match(ui.text(), /可能不完整/);
  await ui.click("断开");
  await ui.click("连接录音卡");
  await ui.click("读取文件列表");
  assert.doesNotMatch(ui.text(), /partial.wav/);
  card.emit(filePayload("complete.wav"));
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /complete.wav/);
  assert.match(ui.text(), /列表读取完成/);
  assert.doesNotMatch(ui.text(), /超时|不完整/);
  ui.unmount();
});

for (const withoutResponse of [true, false]) {
  test(`record/refresh/list writes are serialized (withoutResponse=${withoutResponse})`, async () => {
    const gate = deferred();
    const started = deferred();
    const card = deviceMock({ withoutResponse, writeGate(payload) {
      if (payload[0] === 3 && payload[1] === 1) {
        started.resolve();
        return gate.promise;
      }
    } });
    const ui = mountCard([card]);
    await ui.click("连接录音卡");
    const recording = ui.click("开始录音");
    await started.promise;
    const refresh = ui.click("刷新");
    const list = ui.click("读取文件列表");
    await flushAsync();
    // A queued list has not yet been sent and must not start its response timer.
    ui.advance(2000);
    assert.equal(ui.timers.size, 0);
    assert.doesNotMatch(ui.text(), /超时/);
    const overlaps = card.overlaps;
    gate.resolve();
    await Promise.all([recording, refresh, list]);
    assert.equal(overlaps, 0);
    assert.equal(card.overlaps, 0);
    assert.equal(card.writes.length, 8); // three init + record/state + refresh/status + list
    assert.deepEqual(card.writes.slice(3, 6), [[3, 1], [0, 3], [2, 0]]);
    assert.doesNotMatch(ui.text(), /操作失败|读取文件列表失败/);
    card.emit([2, 18, 0]);
    assert.equal(ui.timers.size, 0);
    ui.unmount();
  });
}

test("initialization shares the queue with buttons clicked before it finishes", async () => {
  const gate = deferred();
  const started = deferred();
  const card = deviceMock({ writeGate(payload) {
    if (payload[0] === 0 && payload[1] === 0) {
      started.resolve();
      return gate.promise;
    }
  } });
  const ui = mountCard([card]);
  const connecting = ui.click("连接录音卡");
  await started.promise;
  const refresh = ui.click("刷新");
  const record = ui.click("开始录音");
  const list = ui.click("读取文件列表");
  await flushAsync();
  const overlaps = card.overlaps;
  gate.resolve();
  await Promise.all([connecting, refresh, record, list]);
  assert.equal(overlaps, 0);
  assert.equal(card.overlaps, 0);
  assert.equal(card.writes.length, 8);
  assert.doesNotMatch(ui.text(), /操作失败|连接失败|读取文件列表失败/);
  ui.unmount();
});

test("a rejected queued write does not poison following operations", async () => {
  const gate = deferred();
  const started = deferred();
  const card = deviceMock({ writeGate(payload) {
    if (payload[0] === 3 && payload[1] === 1) {
      started.resolve();
      return gate.promise;
    }
  } });
  const ui = mountCard([card]);
  await ui.click("连接录音卡");
  const record = ui.click("开始录音");
  await started.promise;
  const refresh = ui.click("刷新");
  await flushAsync();
  gate.reject(new Error("record write failed"));
  await Promise.all([record, refresh]);
  assert.equal(card.overlaps, 0);
  assert.match(ui.text(), /record write failed/);
  assert.deepEqual(card.writes.slice(-2), [[0, 3], [3, 19]]);
  ui.unmount();
});

test("disconnect prevents queued commands from writing to the old session", async () => {
  const gate = deferred();
  const started = deferred();
  const first = deviceMock({ writeGate(payload) {
    if (payload[0] === 3 && payload[1] === 1) {
      started.resolve();
      return gate.promise;
    }
  } });
  const second = deviceMock();
  const ui = mountCard([first, second]);
  await ui.click("连接录音卡");
  const record = ui.click("开始录音");
  await started.promise;
  const refresh = ui.click("刷新");
  const list = ui.click("读取文件列表");
  await flushAsync();
  await ui.click("断开");
  await ui.click("连接录音卡");
  gate.resolve();
  await Promise.all([record, refresh, list]);
  assert.equal(first.overlaps, 0);
  assert.equal(first.writes.length, 4); // only init and the already-started record command
  assert.equal(second.writes.length, 3);
  assert.equal(ui.timers.size, 0);
  assert.doesNotMatch(ui.text(), /操作失败|读取文件列表失败|超时/);
  ui.unmount();
});

for (const doneFirst of [true, false]) {
  test(`timed-out list retry rejects ambiguous late responses (doneFirst=${doneFirst})`, async () => {
    const card = deviceMock();
    const ui = mountCard([card]);
    await ui.click("连接录音卡");
    const staleReadHandler = ui.button("读取文件列表").props.onClick;
    await staleReadHandler();
    ui.advance(1200);
    // Reproduce a retry attempt before the previous response arrives, including
    // invoking an older handler rather than relying only on the disabled button.
    await staleReadHandler();
    if (doneFirst) card.emit([2, 18, 0]);
    card.emit(filePayload("late-old.wav"));
    if (!doneFirst) card.emit([2, 18, 0]);
    assert.doesNotMatch(ui.text(), /列表读取完成|late-old.wav/);
    assert.match(ui.text(), /重新连接/);
    assert.equal(ui.button("读取文件列表").props.disabled, true);
    assert.equal(card.writes.filter((p) => p[0] === 2 && p[1] === 0).length, 1);
    assert.equal(ui.timers.size, 0);
    // Status/recording controls are not disabled by a list timeout.
    await ui.click("刷新");
    assert.deepEqual(card.writes.slice(-2), [[0, 3], [3, 19]]);
    ui.unmount();
  });
}

test("reconnect resets list ambiguity and ignores the previous session's callback", async () => {
  const card = deviceMock();
  const ui = mountCard([card, card]);
  await ui.click("连接录音卡");
  const oldNotify = getEventListeners(card.notify, "characteristicvaluechanged")[0];
  await ui.click("读取文件列表");
  ui.advance(1200);
  assert.match(ui.text(), /重新连接/);
  await ui.click("断开");
  await ui.click("连接录音卡");
  assert.equal(ui.button("读取文件列表").props.disabled, false);
  await ui.click("读取文件列表");
  oldNotify({ target: { value: notification([2, 18, 0]) } });
  oldNotify({ target: { value: notification(filePayload("old-session.wav")) } });
  assert.equal(ui.button("读取文件列表").props.disabled, true);
  assert.doesNotMatch(ui.text(), /列表读取完成|old-session.wav/);
  card.emit(filePayload("fresh.wav"));
  card.emit([2, 18, 0]);
  assert.match(ui.text(), /列表读取完成.*1/);
  assert.match(ui.text(), /fresh.wav/);
  assert.doesNotMatch(ui.text(), /超时|不完整/);
  ui.unmount();
});

for (const body of [[], [1]]) {
  test(`list end without success status remains unconfirmed (body=${JSON.stringify(body)})`, async () => {
    const card = deviceMock();
    const ui = mountCard([card]);
    await ui.click("连接录音卡");
    await ui.click("读取文件列表");
    card.emit(filePayload("unconfirmed.wav"));
    card.emit([2, 18, ...body]);
    assert.match(ui.text(), /unconfirmed.wav/);
    assert.match(ui.text(), /未确认成功.*重新连接/);
    assert.doesNotMatch(ui.text(), /列表读取完成/);
    assert.equal(ui.button("读取文件列表").props.disabled, true);
    assert.equal(ui.timers.size, 0);
    card.emit([2, 18, 0]);
    assert.doesNotMatch(ui.text(), /列表读取完成/);
    ui.unmount();
  });
}
