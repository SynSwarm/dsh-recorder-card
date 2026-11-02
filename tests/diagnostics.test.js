import { recoverCleanupNotice } from "./fixtures/cleanup-recovery.js";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import Tools from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { createConnection } from "../runtime/connection.js";
import { createRecorderService } from "../runtime/host-cli.js";
import RecorderService from "../runtime/service.js";
import { createRecorderContract } from "../runtime/remote-contract.js";
import { registerRecorderTools } from "../runtime/tools.js";
import { remoteRuntime } from "./fixtures/remote-runtime.js";

const progress = { version: 1, operation: "import", phase: "transfer", outcome: "running", cleanup: "pending",
  elapsedMs: 100, bytesReceived: 48, dataFrames: 2, attempts: 1, firstDataMs: 50, lastDataMs: 90,
  frameIntervalSamples: 1, frameIntervalMedianMs: 40, frameIntervalP95Ms: 40, frameIntervalMaxMs: 40,
  stalls: 0, idleTimeoutMs: 12000, dataIdleMs: 10 };
const complete = { ...progress, phase: "done", outcome: "succeeded", cleanup: "retained", endFrameMs: 100, endCode: 0 };
const failed = { ...progress, phase: "failed", failedPhase: "transfer", outcome: "failed", cleanup: "unconfirmed" };
const imported = { status: "succeeded", import: { status: "succeeded", path: "test.wav", bytes: 48, sha256: "a".repeat(64),
  integrity: { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 } },
  transcription: { status: "not-requested" }, cleanup: { status: "retained", errors: [] }, diagnostics: complete };

function transport(t, timeoutMs = 1000) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const sent = [];
  child.stdin.on("data", line => sent.push(JSON.parse(line)));
  const connection = createConnection({ python: "fixture", args: [], timeoutMs, onState: () => {},
    spawnProcess: () => child, terminate: async () => { setImmediate(() => child.emit("close", null)); } });
  t.after(() => child.emit("close", 0));
  return { connection, sent, reply: value => child.stdout.write(JSON.stringify(value) + "\n") };
}

test("progress cannot resolve a request or leak into the next request", async t => {
  const { connection, sent, reply } = transport(t);
  let resolved = false;
  const first = connection.request("importFile").then(value => { resolved = true; return value; });
  const second = connection.request("status");
  await tick();
  reply({ progress: { id: sent[0].id, diagnostics: progress } });
  await tick();
  assert.equal(resolved, false);
  assert.equal(sent.length, 1);
  reply({ id: sent[0].id, result: { ...imported, diagnostics: complete } });
  assert.equal((await first).diagnostics.bytesReceived, 48);
  await tick();
  reply({ progress: { id: sent[0].id, diagnostics: progress } });
  reply({ id: sent[1].id, result: { code: 0, out: "", err: "" } });
  assert.equal((await second).diagnostics, undefined);
});

test("cancellation and deadline preserve the last progress with age and unconfirmed cleanup", async t => {
  for (const cancel of [true, false]) {
    const { connection, sent, reply } = transport(t, 80);
    const controller = new AbortController();
    const request = connection.request("importFile", {}, { signal: controller.signal });
    const checked = assert.rejects(request, error => {
      assert.equal(error.name, cancel ? "AbortError" : "TimeoutError");
      assert.equal(error.diagnostics.outcome, cancel ? "cancelled" : "failed");
      assert.equal(error.diagnostics.bytesReceived, 48);
      assert.equal(error.diagnostics.failedPhase, "transfer");
      assert.equal(error.diagnostics.cleanup, "unconfirmed");
      assert.ok(error.diagnostics.snapshotAgeMs >= 0);
      return true;
    });
    await tick();
    reply({ progress: { id: sent[0].id, diagnostics: progress } });
    if (cancel) controller.abort();
    await checked;
    await connection.closed;
  }
});

test("queued cancellation reports zero attempts and does not inherit active transfer bytes", async t => {
  const { connection, sent, reply } = transport(t);
  const active = connection.request("importFile");
  await tick();
  reply({ progress: { id: sent[0].id, diagnostics: progress } });
  const controller = new AbortController();
  const queued = connection.request("list", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, error => {
    assert.equal(error.diagnostics.phase, "queued");
    assert.equal(error.diagnostics.cleanup, "not-needed");
    assert.equal(error.diagnostics.bytesReceived, 0);
    assert.equal(error.diagnostics.attempts, 0);
    return true;
  });
  reply({ id: sent[0].id, result: imported });
  await active; await tick();
  assert.equal(sent.length, 1);
});

test("worker terminal cleanup failure supersedes running progress without losing transfer counters", async t => {
  const { connection, sent, reply } = transport(t);
  const request = connection.request("importFile");
  const checked = assert.rejects(request, error => {
    assert.equal(error.name, "CleanupError");
    assert.equal(error.diagnostics.cleanup, "unconfirmed");
    assert.equal(error.diagnostics.bytesReceived, 48);
    assert.equal(error.diagnostics.phase, "failed");
    return true;
  });
  await tick();
  reply({ progress: { id: sent[0].id, diagnostics: progress } });
  reply({ id: sent[0].id, error: "transfer interrupted", cleanupError: "disconnect failed", diagnostics: failed });
  await checked;
});

test("Python operation deadline remains a timeout when cleanup is confirmed", async t => {
  const { connection, sent, reply } = transport(t);
  const request = connection.request("importFile");
  const checked = assert.rejects(request, error => {
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.diagnostics.cleanup, "succeeded");
    assert.equal(error.diagnostics.frameIntervalMedianMs, 40);
    return true;
  });
  await tick();
  reply({ id: sent[0].id, error: "operation deadline", errorCode: "OPERATION_TIMEOUT",
    diagnostics: { ...failed, cleanup: "succeeded" } });
  await checked;
});

test("one-shot timeout recovers a heartbeat report, including queue delay and snapshot age", async t => {
  t.after(recoverCleanupNotice);
  let observed;
  const cli = createRecorderService({ deviceAddress: "test" }, {
    onDiagnostic: value => { observed = value; },
    execute: async (_command, args) => {
      await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify({ version: 2, imports: [], transcriptions: [],
        cleanup: { status: "pending", errors: [] }, diagnostics: progress }));
      await delay(10);
      throw Object.assign(new Error("process deadline"), { name: "TimeoutError" });
    },
  });
  t.after(() => cli.dispose());
  await assert.rejects(cli.importFile("test.wav"), error => {
    assert.equal(error.name, "CleanupError");
    assert.equal(error.cause.name, "TimeoutError");
    assert.equal(error.diagnostics.bytesReceived, 48);
    assert.equal(error.diagnostics.cleanup, "unconfirmed");
    assert.equal(error.diagnostics.outcome, "failed");
    assert.ok(error.diagnostics.snapshotAgeMs >= 0);
    assert.ok(error.diagnostics.queueMs >= 0);
    assert.deepEqual(observed, error.diagnostics);
    return true;
  });
});

test("Host saves bounded diagnostics after cancellation even when DSH hides the error message", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "recorder-diagnostics-"));
  const ctx = new Context();
  const mounted = ctx.plugin(RecorderService, { dataDir, deviceAddress: "test-private-address" });
  await mounted;
  t.after(async () => { await mounted.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  // A cancelled import never starts Python, but exercises the real Host observer and store.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(ctx.recorder.cli.importFile("private-test.wav", undefined, false,
      { signal: AbortSignal.abort() }), { name: "AbortError" });
  }
  const text = await readFile(join(dataDir, "recorder-diagnostics.json"), "utf8");
  const saved = JSON.parse(text);
  assert.equal(saved.diagnostics.outcome, "cancelled");
  assert.equal(saved.diagnostics.cleanup, "not-needed");
  assert.ok(Number.isFinite(Date.parse(saved.recordedAt)));
  assert.doesNotMatch(text, /private-test|private-address/);
  assert.deepEqual(await readdir(dataDir), ["recorder-diagnostics.json"]);
});

test("one-shot final reports keep counters through success and cleanup error translation", async t => {
  t.after(recoverCleanupNotice);
  let failure = false;
  const cli = createRecorderService({ deviceAddress: "test" }, { execute: async (_command, args) => {
    const diagnostics = failure ? failed : { ...complete, cleanup: "succeeded" };
    await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify({ version: 2,
      imports: failure ? [] : [{ ...imported.import, path: join(args[args.indexOf("--out") + 1], "test.wav") }],
      transcriptions: [], diagnostics,
      error: failure ? { code: "TRANSFER_INTERRUPTED", message: "transfer incomplete" } : undefined,
      cleanup: { status: failure ? "unconfirmed" : "succeeded", errors: failure ? [{ code: "DEVICE_CLEANUP_FAILED", message: "first disconnect failed" }] : [] } }));
    if (failure) throw Object.assign(new Error("exit 1"), { name: "CliExitError" });
    return { code: 0, out: "", err: "" };
  } });
  t.after(() => cli.dispose());
  assert.equal((await cli.importFile("test.wav")).diagnostics.endCode, 0);
  failure = true;
  await assert.rejects(cli.importFile("test.wav"), error => {
    assert.equal(error.name, "CleanupError");
    assert.equal(error.diagnostics.cleanup, "unconfirmed");
    assert.equal(error.diagnostics.bytesReceived, 48);
    assert.match(error.message, /first disconnect failed/);
    return true;
  });
});

test("diagnostic storage failure does not replace the primary operation error", async t => {
  t.after(recoverCleanupNotice);
  t.mock.method(console, "warn", () => {});
  const cli = createRecorderService({ deviceAddress: "test" }, {
    onDiagnostic: async () => { throw Object.assign(new Error("read-only diagnostic store"), { code: "EACCES" }); },
    execute: async () => { throw Object.assign(new Error("test process deadline"), { name: "TimeoutError" }); },
  });
  t.after(() => cli.dispose());
  await assert.rejects(cli.importFile("test.wav"), error => {
    assert.equal(error.name, "CleanupError");
    assert.equal(error.cause.name, "TimeoutError");
    assert.equal(error.cause.message, "test process deadline");
    assert.equal(error.diagnostics.cleanup, "unconfirmed");
    return true;
  });
  assert.equal(console.warn.mock.callCount(), 1);
});

test("official Remote and Tool boundaries preserve diagnostics on success and typed errors", async t => {
  let fail = false;
  const service = { importFirst: async () => {
    if (fail) throw Object.assign(new Error("transfer interrupted"), { name: "TransferInterruptedError", diagnostics: failed });
    return imported;
  } };
  const { client } = await remoteRuntime(t, service);
  const ctx = new Context(), mounts = [];
  t.after(async () => { for (const mount of mounts.reverse()) await mount.dispose(); });
  for (const plugin of [SystemPrompt, Tools, { inject: ["tools"], apply: ctx => registerRecorderTools(ctx, service) }]) {
    const mount = ctx.plugin(plugin); mounts.push(mount); await mount;
  }
  const call = () => ctx.tools.execute({ callId: "diagnostics-test", name: "recorder_import", arguments: {}, signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(JSON.stringify((await client.remote.recorder.importFirst(undefined)).value.diagnostics)), complete);
  assert.deepEqual((await call()).value.diagnostics, complete);
  fail = true;
  const remote = await client.remote.recorder.importFirst(undefined);
  assert.equal(remote.error.code, "recorder/transfer-interrupted");
  assert.deepEqual(JSON.parse(JSON.stringify(remote.error.details.diagnostics)), failed);
  const tool = await call();
  assert.equal(tool.error.info.code, "RECORDER_TRANSFER_INTERRUPTED");
  assert.deepEqual(JSON.parse(tool.error.message.split("; recorder diagnostics: ")[1]), failed);
});

test("diagnostic parser rejects payloads, identifiers and invalid counters", () => {
  const { parseDiagnostics } = createRecorderContract();
  for (const extra of [{ filename: "private.wav" }, { address: "test" }, { payload: "audio" },
    { bytesReceived: -1 }, { elapsedMs: Infinity }, { dataFrames: 1.5 }]) {
    assert.throws(() => parseDiagnostics({ ...progress, ...extra }), TypeError);
  }
});
