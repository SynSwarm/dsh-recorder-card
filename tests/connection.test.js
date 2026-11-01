import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createConnection } from "../runtime/connection.js";
import { createRecorderService } from "../runtime/host-cli.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function transport() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const sent = [], states = [];
  child.stdin.on("data", line => sent.push(JSON.parse(line)));
  const reply = value => child.stdout.write(JSON.stringify(value) + "\n");
  const connection = createConnection({ python: "test", args: [], timeoutMs: 1000,
    spawnProcess: () => child, onState: state => states.push(state),
    terminate: async () => { setImmediate(() => child.emit("close", null)); },
  });
  return { child, connection, sent, states, reply };
}

test("persistent transport serializes operations and propagates real drop events", async () => {
  const { child, connection, sent, states, reply } = transport();
  const first = connection.request("status"), second = connection.request("list");
  await tick(); assert.equal(sent.length, 1);
  reply({ id: sent[0].id, result: { code: 0 } });
  await first; await tick(); assert.equal(sent.length, 2);
  reply({ id: sent[1].id, result: { code: 0 } }); await second;
  reply({ event: { status: "disconnected", name: "test" } });
  assert.equal(states.at(-1).status, "disconnected");
  child.emit("close", 0); await connection.closed;
  await assert.rejects(connection.request("list"), /closed/);
});

test("cancellation retires worker, rejects queued writes and waits for process close", async () => {
  const { connection, sent } = transport();
  const control = new AbortController();
  const first = connection.request("connect", {}, { signal: control.signal });
  const second = connection.request("status");
  const checkFirst = assert.rejects(first, { name: "AbortError" });
  const checkSecond = assert.rejects(second, /closed/);
  await tick(); control.abort();
  await Promise.all([checkFirst, checkSecond, connection.closed]);
  assert.equal(sent.length, 1);
});

test("queued cancellation returns before the active request finishes, without retiring it", async t => {
  const { child, connection, sent, reply } = transport();
  t.after(() => child.emit("close", 0));
  const active = connection.request("status");
  active.catch(() => {});
  await tick();
  const control = new AbortController();
  const queued = connection.request("list", {}, { signal: control.signal });
  let outcome;
  queued.then(() => { outcome = "succeeded"; }, error => { outcome = error.name; });
  control.abort(); await tick();
  assert.equal(outcome, "AbortError");
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(sent.length, 1);
  const next = connection.request("recordState"); next.catch(() => {});
  reply({ id: sent[0].id, result: { code: 0 } }); await active; await tick();
  assert.deepEqual(sent.map(item => item.method), ["status", "recordState"]);
  reply({ id: sent[1].id, result: { code: 0 } }); await next;
});

test("unexpected drop closes stdin and releases the global lease only after worker close", async t => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.stdin.on("data", line => {
    const request = JSON.parse(line);
    child.stdout.write(JSON.stringify({ id: request.id, result: { status: "connected", name: "test" } }) + "\n");
  });
  const owner = createRecorderService({}, { openConnection: options => createConnection({ ...options, spawnProcess: () => child }) });
  let scans = 0;
  const other = createRecorderService({}, { execute: async () => { scans++; return { code: 0, out: "", err: "" }; } });
  t.after(async () => { child.emit("close", 0); await owner.dispose(); await other.dispose(); });
  await owner.connect();
  const scan = other.scan();
  child.stdout.write(JSON.stringify({ event: { status: "disconnected", name: "test" } }) + "\n");
  await tick();
  assert.equal(owner.connectionState().status, "disconnected");
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(scans, 0, "cleanup/stdio have not finished yet");
  child.emit("close", 0);
  await scan; assert.equal(scans, 1);
});

test("drop retirement escalates if the worker does not exit after stdin closes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { connection, child, states, reply } = transport();
  reply({ event: { status: "disconnected", name: "test" } });
  assert.equal(child.stdin.writableEnded, true);
  t.mock.timers.tick(10_000);
  await connection.closed;
  assert.ok(states.some(state => state.message?.includes("未确认")));
});

for (const busy of [false, true]) test(`real Python worker exits on drop and unblocks another service (busy=${busy})`, { timeout: 8000 }, async t => {
  const owner = createRecorderService({ deviceAddress: "test", cliTimeoutMs: 3000 }, {
    openConnection: options => createConnection({ ...options,
      args: ["-B", fileURLToPath(new URL("./fixtures/dropping-worker.py", import.meta.url))] }),
  });
  let scans = 0;
  const other = createRecorderService({}, { execute: async () => { scans++; return { code: 0, out: "", err: "" }; } });
  t.after(async () => { await owner.dispose(); await other.dispose(); });
  await owner.connect();
  const pending = busy ? assert.rejects(owner.status(), /Device disconnected/) : Promise.resolve();
  await other.scan(); // No explicit disconnect; requires real process/stdio exit.
  await pending;
  assert.equal(owner.connectionState().status, "disconnected");
  assert.equal(scans, 1);
});

test("first cleanup failure is returned even if the worker then exits normally", async () => {
  const { child, connection, sent, reply } = transport();
  const request = connection.request("disconnect");
  const check = assert.rejects(request, { name: "CleanupError" });
  await tick(); reply({ id: sent[0].id, error: "disconnect failed", cleanupError: "release unconfirmed" });
  await check; child.emit("close", 0); await connection.closed;
});

test("idle cleanup warning remains the terminal state after nonzero process close", async () => {
  const { child, connection, states, reply } = transport();
  reply({ event: { status: "disconnected", name: "test" } });
  reply({ event: { status: "cleanup-unconfirmed", name: "test", message: "first disconnect failed" } });
  child.emit("close", 1);
  await connection.closed;
  assert.equal(states.at(-1).status, "cleanup-unconfirmed");
  assert.match(states.at(-1).message, /first disconnect failed/);
  await connection.dispose();
  assert.equal(states.at(-1).status, "cleanup-unconfirmed");
});

test("abnormal exit without a cleanup event still reports release as unconfirmed", async () => {
  const { child, connection, states } = transport();
  child.emit("close", 1); await connection.closed;
  assert.equal(states.at(-1).status, "cleanup-unconfirmed");
  assert.match(states.at(-1).message, /exited unexpectedly/);
});

test("selection-only worker exits without a second disconnect request or false failure", async () => {
  const { child, connection, sent, reply } = transport();
  const request = connection.request("connect"); await tick();
  reply({ id: sent[0].id, result: { status: "selection-required", name: "", devices: [] } });
  await request; const disposing = connection.dispose();
  child.emit("close", 0); await disposing;
  assert.equal(sent.length, 1);
});

test("dispose preserves first disconnect failure instead of reporting successful release", async () => {
  const { connection, sent, reply } = transport();
  const disposing = connection.dispose();
  const check = assert.rejects(disposing, { name: "CleanupError" });
  await tick(); reply({ id: sent[0].id, error: "disconnect failed", cleanupError: "release unconfirmed" });
  await check;
});

test("shared BLE lease covers the whole connection; same owner reuses it, disposal releases it", async () => {
  let started = 0, released;
  const calls = [];
  const connected = { status: "connected", name: "test", address: "test-only" };
  const service = createRecorderService({ deviceAddress: "test-only" }, { openConnection: options => {
    started++;
    const closed = new Promise(resolve => { released = resolve; });
    return { closed, async request(method) { calls.push(method); return method === "connect" ? connected : { code: 0, out: "ok", err: "" }; },
      async dispose() { options.onState({ status: "disconnected", name: "" }); released(); } };
  } });
  let otherRuns = 0;
  const other = createRecorderService({}, { execute: async () => { otherRuns++; return { code: 0, out: "", err: "" }; } });
  try {
    await Promise.all([service.connect(), service.connect(), service.status()]);
    assert.equal(started, 1);
    assert.deepEqual(calls, ["connect", "status"]);
    const scan = other.scan(); await tick(); assert.equal(otherRuns, 0);
    await service.list(); assert.equal(calls.at(-1), "list");
    await service.dispose(); await scan; assert.equal(otherRuns, 1);
  } finally { await service.dispose(); await other.dispose(); }
});

test("disconnect cancels a connection waiting behind another BLE owner without spawning", async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const owner = createRecorderService({}, { execute: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { code: 0, out: "", err: "" }; } });
  let spawned = false;
  const next = createRecorderService({}, { openConnection() { spawned = true; throw new Error("must not spawn"); } });
  const scan = owner.scan(); await ready;
  const connect = next.connect(); const checked = assert.rejects(connect, { name: "AbortError" });
  await tick();
  // Queue cancellation must not wait for the other owner's scan.
  await next.disconnect().catch(error => { assert.equal(error.name, "AbortError"); });
  await checked; assert.equal(spawned, false);
  release(); await scan; await owner.dispose(); await next.dispose().catch(() => {});
});

test("real idle cleanup failure warns queued and new callers before any BLE retry", { timeout: 8000 }, async t => {
  const owner = createRecorderService({ deviceAddress: "test", cliTimeoutMs: 3000 }, {
    openConnection: options => createConnection({ ...options,
      args: ["-B", fileURLToPath(new URL("./fixtures/dropping-worker.py", import.meta.url)), "--cleanup-fail"] }),
  });
  let scans = 0;
  const execute = async () => { scans++; return { code: 0, out: "", err: "" }; };
  const other = createRecorderService({}, { execute });
  const later = createRecorderService({}, { execute });
  const recovery = createRecorderService({}, { openConnection: options => {
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    return { closed,
      async request() { return { status: "connected", name: "test" }; },
      async dispose() { options.onState({ status: "disconnected", name: "" }); close(); },
    };
  } });
  t.after(async () => { for (const service of [owner, other, later, recovery]) await service.dispose(); });
  await owner.connect();
  const check = { name: "CleanupError", message: /idle cleanup failed.*no device operation was started/ };
  await Promise.all([assert.rejects(other.scan(), check), assert.rejects(other.scan(), check)]);
  assert.equal(scans, 0);
  assert.equal(owner.connectionState().status, "cleanup-unconfirmed");
  assert.match(owner.connectionState().message, /idle cleanup failed/);
  assert.equal((await owner.disconnect()).status, "cleanup-unconfirmed");
  await assert.rejects(later.scan(), check); // New instance also sees the warning first.
  assert.equal(scans, 0);
  await other.scan(); // Explicit retry after the warning was delivered.
  assert.equal(scans, 1);
  await assert.rejects(recovery.connect(), check);
  await recovery.connect(); // New confirmed session clears the shared notice.
  await recovery.disconnect();
  const fresh = createRecorderService({}, { execute });
  await fresh.scan(); await fresh.dispose();
  assert.equal(scans, 2);
  assert.equal(owner.connectionState().status, "cleanup-unconfirmed", "other recovery cannot rewrite old evidence");
});
