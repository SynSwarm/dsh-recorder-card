import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRecorderService, runProcess } from "../runtime/host-cli.js";
import * as plugin from "../index.js";
import { Context } from "@deepseek-ai/cordis";
import { recoverCleanupNotice } from "./fixtures/cleanup-recovery.js";

const integrity = { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 };
const cleanup = { status: "succeeded", errors: [] };

test("configured watchdog reaches both Python entry points with a cleanup reserve", async () => {
  for (const [cliTimeoutMs, expected] of [[190000, 180], [610000, 600], [1000, .5]]) {
    let command, workerOptions, close;
    const cli = createRecorderService({ cliTimeoutMs }, {
      execute: async (_python, args, options) => { command = { args, options }; return { code: 0, out: "", err: "" }; },
      openConnection: options => {
        workerOptions = options;
        return { closed: new Promise(resolve => { close = resolve; }),
          request: async () => ({ status: "connected", name: "test" }), dispose: async () => close() };
      },
    });
    try {
      await cli.scan();
      assert.equal(Number(command.args[command.args.indexOf("--timeout") + 1]), expected);
      assert.ok(command.args.indexOf("--timeout") < command.args.indexOf("--"));
      assert.equal(command.options.timeoutMs, cliTimeoutMs);
      await cli.connect();
      assert.equal(Number(workerOptions.args[workerOptions.args.indexOf("--timeout") + 1]), expected);
      assert.equal(workerOptions.timeoutMs, cliTimeoutMs);
    } finally { await cli.dispose(); }
  }
});

test("adapter deadline exit has the timeout code rather than a generic CLI failure", async t => {
  const cli = createRecorderService({}, { execute: async () => {
    throw Object.assign(new Error("exit 124"), { name: "CliExitError", code: 124 });
  } });
  t.after(() => cli.dispose());
  await assert.rejects(cli.scan(), { name: "TimeoutError", code: 124 });
});

test("named one-shot import passes one literal filename and rejects paths/batches before spawn", async t => {
  const dataDir = await temp(t), calls = [];
  const service = createRecorderService({ dataDir, deviceAddress: "test" }, { execute: async (_cmd, args) => {
    calls.push(args);
    await writeImportReport(args);
    return { code: 0, out: "", err: "" };
  } });
  t.after(() => service.dispose());
  const result = await service.importFile("--second file.wav", dataDir);
  assert.equal(result.status, "succeeded");
  assert.ok(calls[0].includes("--filename=--second file.wav"));
  assert.ok(!calls[0].includes("--import-all") && !calls[0].includes("--import-first"));
  for (const filename of ["", " first.wav", "a,b", "../test.wav", "sub\\test.wav", 42, "test\0.wav"]) {
    await assert.rejects(service.importFile(filename), { name: "TypeError" });
  }
  assert.equal(calls.length, 1);
});

test("one-shot import keeps typed transfer failures and prioritizes unconfirmed cleanup", async t => {
  t.after(recoverCleanupNotice);
  const dataDir = await temp(t);
  let code = "TRANSFER_INTERRUPTED", cleanupStatus = "succeeded";
  const service = createRecorderService({ dataDir, deviceAddress: "test" }, { execute: async (_cmd, args) => {
    await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify({ version: 2, imports: [], transcriptions: [],
      error: { code, message: "Transfer incomplete; reconnect and retry from the beginning" },
      cleanup: { status: cleanupStatus, errors: cleanupStatus === "unconfirmed" ? [{ code: "DEVICE_CLEANUP_FAILED", message: "first disconnect failed" }] : [] } }));
    throw Object.assign(new Error("exit 1"), { name: "CliExitError" });
  } });
  t.after(() => service.dispose());
  await assert.rejects(service.importFile("test.wav"), { name: "TransferInterruptedError" });
  code = "DEVICE_DISCONNECTED";
  await assert.rejects(service.importFile("test.wav"), { name: "DeviceDisconnectedError" });
  cleanupStatus = "unconfirmed";
  await assert.rejects(service.importFile("test.wav"), error => error.name === "CleanupError" && /first disconnect failed/.test(error.message));
});

const fixture = fileURLToPath(new URL("./fixtures/cli-child.mjs", import.meta.url));
const child = (mode, target, options = {}) => runProcess(process.execPath,
  [fixture, mode, ...(target ? [target] : [])], { timeoutMs: 5000, ...options });
async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), "recorder-host-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function ready(path) {
  for (let i = 0; i < 500; i++) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("Fixture did not become ready");
}
function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("process runner preserves UTF-8 across output chunks and returns nonzero diagnostics", async () => {
  assert.deepEqual(await child("success"), { code: 0, out: "测试 recording", err: "" });
  await assert.rejects(child("fail"), { name: "CliExitError", code: 7, err: "unconfirmed response" });
  assert.equal((await child("success")).code, 0);
});

test("missing executable and invalid cwd fail with actionable spawn errors", async () => {
  await assert.rejects(runProcess("recorder-nonexistent-executable", []), { name: "CliSpawnError" });
  await assert.rejects(child("success", undefined, { cwd: join(fixture, "missing") }), { name: "CliSpawnError" });
});

test("output limits and wall-clock deadlines terminate unresponsive children", async () => {
  await assert.rejects(child("flood", undefined, { maxOutputBytes: 100 }), { name: "OutputLimitError" });
  await assert.rejects(child("hold", undefined, { timeoutMs: 200 }), { name: "TimeoutError" });
});

test("cancelling a running process waits for the child and its descendant to exit", async (t) => {
  const path = join(await temp(t), "ready");
  const controller = new AbortController();
  const result = child("tree", path, { signal: controller.signal });
  const rejection = assert.rejects(result, { name: "AbortError" });
  t.after(() => controller.abort());
  const pids = JSON.parse(await ready(path));
  await ready(`${path}.child`);
  controller.abort();
  await rejection;
  assertExited(pids.parent);
  assertExited(pids.child);
});

test("pre-cancelled operations never spawn", async () => {
  await assert.rejects(runProcess("recorder-nonexistent-executable", [], { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("device methods and scans serialize across service instances; failures release the queue", async (t) => {
  const lock = join(await temp(t), "device.lock");
  let failNext = true;
  const calls = [];
  const execute = (_cmd, args, options) => {
    calls.push(args);
    if (failNext) { failNext = false; return child("fail", undefined, options); }
    return child("exclusive", lock, options);
  };
  const a = createRecorderService({ deviceAddress: "test-device" }, { execute });
  const b = createRecorderService({ deviceAddress: "test-device" }, { execute });
  t.after(() => Promise.all([a.dispose(), b.dispose()]));
  const results = await Promise.allSettled([a.status(), b.scan(), a.record("pause"), b.list(), a.recordState()]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason.name, "CliExitError");
  for (const result of results.slice(1)) assert.equal(result.status, "fulfilled");
  assert.deepEqual(calls.map((args) => args.slice(args.indexOf("--") + 1)), [
    ["--address", "test-device", "--status"], ["--scan"],
    ["--address", "test-device", "--record", "pause"],
    ["--address", "test-device", "--list"], ["--address", "test-device", "--record-state"],
  ]);
});

test("queued cancellation rejects promptly without spawning or cancelling the active request", async (t) => {
  const path = join(await temp(t), "ready");
  const calls = [];
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: (_cmd, args, options) => {
    calls.push(args);
    return child("hold", path, options);
  } });
  t.after(() => service.dispose());
  const active = service.list();
  const stopped = assert.rejects(active, { name: "AbortError" });
  const pid = Number(await ready(path));
  const controller = new AbortController();
  const queued = service.record("start", { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => process.kill(pid, 0));
  await service.dispose();
  await stopped;
  assertExited(pid);
});

test("dispose cancels active/queued calls and prevents reuse; a new instance can proceed after exit", async (t) => {
  const path = join(await temp(t), "ready");
  let calls = 0;
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: (_cmd, _args, options) => {
    calls++;
    return child("hold", path, options);
  } });
  t.after(() => service.dispose());
  const active = assert.rejects(service.status(), { name: "AbortError" });
  const pid = Number(await ready(path));
  const queued = assert.rejects(service.record("start"), { name: "AbortError" });
  const disposal = service.dispose();
  const next = createRecorderService({}, { execute: () => {
    assertExited(pid);
    return child("success");
  } });
  t.after(() => next.dispose());
  assert.equal((await next.scan()).code, 0);
  await Promise.all([active, queued, disposal, service.dispose()]);
  await assert.rejects(service.scan(), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("standalone transcription does not occupy BLE queue but is cancelled on disposal", async (t) => {
  const path = join(await temp(t), "ready");
  const calls = [];
  const service = createRecorderService({ repoRoot: await temp(t) }, { execute: (_cmd, args, options) => {
    calls.push(args);
    return args.includes("--transcribe-file") ? child("hold", path, options) : child("success", undefined, options);
  } });
  t.after(() => service.dispose());
  const transcription = assert.rejects(service.transcribe("--input.wav", { force: true }), { name: "AbortError" });
  const pid = Number(await ready(path));
  assert.equal((await service.scan()).code, 0);
  assert.equal(calls[0].at(-1), "--force");
  assert.ok(calls[0][calls[0].indexOf("--transcribe-file") + 1].endsWith("--input.wav"));
  await service.dispose();
  await transcription;
  assertExited(pid);
});

test("termination failure reports an error and holds the device queue until actual exit", async (t) => {
  const path = join(await temp(t), "ready");
  const controller = new AbortController();
  const service = createRecorderService({}, { execute: (_cmd, _args, options) => child("hold", path, {
    ...options, terminate: async () => { throw new Error("permission denied"); },
  }) });
  const result = service.scan({ signal: controller.signal });
  let cleanupError;
  const rejection = assert.rejects(result, (error) => {
    cleanupError = error;
    return error.name === "CleanupError" && error.operationError.name === "AbortError";
  });
  const pid = Number(await ready(path));
  t.after(async () => {
    try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await cleanupError?.closed;
    await service.dispose();
  });
  controller.abort();
  await rejection;
  await assert.rejects(service.dispose(), { name: "CleanupError" });
  let nextStarted = false;
  const next = createRecorderService({}, { execute: () => {
    nextStarted = true;
    assertExited(pid);
    return child("success");
  } });
  t.after(() => next.dispose());
  const nextResult = next.scan();
  await delay(20);
  assert.equal(nextStarted, false);
  process.kill(pid);
  await cleanupError.closed;
  assert.equal((await nextResult).code, 0);
  await service.dispose();
});

test("invalid configuration and action arguments fail before starting any CLI", async () => {
  let calls = 0;
  const execute = async () => { calls++; return {}; };
  for (const config of [{ python: "" }, { repoRoot: 42 }, { dataDir: "" }, { cliTimeoutMs: 0 }, { cliTimeoutMs: Infinity }]) {
    assert.throws(() => createRecorderService(config, { execute }), TypeError);
  }
  const service = createRecorderService({}, { execute });
  await assert.rejects(service.status(), /deviceAddress/);
  await assert.rejects(service.list(), /deviceAddress/);
  await assert.rejects(service.record("delete"), /recording action/);
  await assert.rejects(service.transcribe(""), /file/);
  await assert.rejects(service.transcribe("test.wav", { force: "true" }), /boolean/);
  await assert.rejects(service.importFirst("output", "true"), /boolean/);
  await service.dispose();
  assert.equal(calls, 0);
});

test("import paths resolve under dataDir and literal path arguments stay separate", async () => {
  let invocation;
  const repoRoot = resolve("test checkout");
  const dataDir = resolve("test data");
  const service = createRecorderService({ repoRoot, dataDir, python: "python with spaces", deviceAddress: "test-device" }, {
    execute: async (...args) => {
      invocation = args;
      await writeImportReport(args[1], { status: "succeeded", exitCode: 0 });
      return { code: 0 };
    },
  });
  await service.importFirst("audio with spaces", true);
  assert.equal(invocation[0], "python with spaces");
  assert.deepEqual(invocation[1].slice(invocation[1].indexOf("--") + 1), ["--address", "test-device",
    "--import-first", "--out", resolve(dataDir, "audio with spaces"), "--transcribe"]);
  await service.dispose();
});

test("Host disposal closes its injectable recorder service", async (t) => {
  const ctx = new Context();
  ctx.provide("tools", { register() {} });
  ctx.provide("skills", { registerProvider() {} });
  const mounted = ctx.plugin(plugin, { dataDir: await temp(t) });
  t.after(() => mounted.dispose());
  await mounted;
  const service = ctx.recorder;
  await mounted.dispose();
  await assert.rejects(service.scan(), { name: "AbortError" });
});

test("default and empty repoRoot use bundled sources while data and transcription stay separate", async (t) => {
  const dataDir = await temp(t);
  const bundled = resolve(fileURLToPath(new URL("../vendor/upstream/", import.meta.url)));
  for (const repoRoot of [undefined, ""]) {
    const calls = [];
    const service = createRecorderService({ repoRoot, dataDir }, { execute: async (_cmd, args, options) => {
      calls.push({ args, cwd: options.cwd }); return { code: 0, out: "", err: "" };
    } });
    t.after(() => service.dispose());
    await service.scan();
    await service.transcribe("archive/audio/test.wav");
    for (const { args, cwd } of calls) {
      assert.equal(args[0], "-B");
      assert.equal(args[args.indexOf("--repo-root") + 1], bundled);
      assert.equal(args[args.indexOf("--data-dir") + 1], dataDir);
      assert.equal(cwd, bundled);
    }
    assert.equal(calls[1].args[calls[1].args.indexOf("--transcribe-file") + 1], join(dataDir, "archive/audio/test.wav"));
  }
  assert.throws(() => createRecorderService({ dataDir: bundled }), /outside the CLI source/);
  const service = createRecorderService({ dataDir, deviceAddress: "synthetic-device" });
  t.after(() => service.dispose());
  await assert.rejects(service.importFirst(join(bundled, "audio")), /outside the CLI source/);
});

async function writeImportReport(args, transcription, transform = value => value) {
  const reportPath = args[args.indexOf("--result-file") + 1];
  const destination = args[args.indexOf("--out") + 1];
  const audio = { status: "succeeded", path: join(destination, "test.wav"), bytes: 5, sha256: "a".repeat(64), integrity };
  await writeFile(reportPath, JSON.stringify(transform({ version: 2, cleanup, imports: [audio],
    transcriptions: transcription ? [{ ...transcription, audioPath: audio.path }] : [] })));
  return { reportPath, audio };
}

test("import keeps saved audio and reports failed transcription with a retry path", async (t) => {
  const destination = await temp(t);
  let reportPath;
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    const written = await writeImportReport(args, { status: "failed", exitCode: 9, error: { code: "TRANSCRIPTION_FAILED", message: "quota" } });
    reportPath = written.reportPath;
    await writeFile(written.audio.path, "saved");
    throw Object.assign(new Error("transcription failed after import"), { name: "CliExitError", code: 1 });
  } });
  t.after(() => service.dispose());
  const result = await service.importFirst(destination, true);
  assert.equal(result.status, "partial");
  assert.equal(result.import.status, "succeeded");
  assert.equal(result.transcription.status, "failed");
  assert.equal(result.transcription.exitCode, 9);
  assert.equal(result.transcription.retry.arguments.file, result.import.path);
  assert.equal(await readFile(result.import.path, "utf8"), "saved");
  await assert.rejects(access(reportPath), { code: "ENOENT" });
});

test("import without transcription requires a report and ignores misleading log output", async (t) => {
  t.after(recoverCleanupNotice);
  const destination = await temp(t);
  let writesReport = true;
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    if (writesReport) await writeImportReport(args);
    return { code: 0, out: "DONE transcription\npretend everything succeeded", err: "" };
  } });
  t.after(() => service.dispose());
  assert.equal((await service.importFirst(destination)).transcription.status, "not-requested");
  writesReport = false;
  await assert.rejects(service.importFirst(destination), { name: "CleanupError" });
});

test("invalid report and unconfirmed transcription cannot become successful import workflows", async (t) => {
  const destination = await temp(t);
  for (const [index, change] of [value => ({ ...value, version: 99 }), value => ({ ...value, imports: [] }),
    value => ({ ...value, transcriptions: [{ status: "running", audioPath: value.imports[0].path, exitCode: null }] })].entries()) {
    const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
      await writeImportReport(args, { status: "succeeded", exitCode: 0 }, change);
      return { code: 0 };
    } });
    await assert.rejects(service.importFirst(destination, true), { name: index === 0 ? "CleanupError" : "ImportResultError" });
    await service.dispose();
    if (index === 0) await recoverCleanupNotice();
  }
});

test("cancellation after import keeps audio and reports its path without reporting workflow success", async (t) => {
  const destination = await temp(t);
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    const { audio } = await writeImportReport(args);
    await writeFile(audio.path, "saved");
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  } });
  t.after(() => service.dispose());
  await assert.rejects(service.importFirst(destination), error => error.name === "AbortError" && error.message.includes(join(destination, "test.wav")));
  assert.equal(await readFile(join(destination, "test.wav"), "utf8"), "saved");
});

test("interrupted transcription still reports the retained audio path", async (t) => {
  const destination = await temp(t);
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    const { audio } = await writeImportReport(args, { status: "running", exitCode: null });
    await writeFile(audio.path, "saved");
    throw Object.assign(new Error("cancelled during ASR"), { name: "AbortError" });
  } });
  t.after(() => service.dispose());
  await assert.rejects(service.importFirst(destination, true), error => error.name === "AbortError" && error.message.includes(join(destination, "test.wav")));
  assert.equal(await readFile(join(destination, "test.wav"), "utf8"), "saved");
});

test("transcription and device cleanup failures both survive the partial result", async (t) => {
  t.after(recoverCleanupNotice);
  const destination = await temp(t);
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    await writeImportReport(args, { status: "failed", exitCode: 9, error: { code: "TRANSCRIPTION_FAILED", message: "quota" } }, value => ({
      ...value, cleanup: { status: "unconfirmed", errors: [{ code: "DEVICE_CLEANUP_FAILED", message: "disconnect failed" }] },
    }));
    throw Object.assign(new Error("ASR failed"), { name: "CliExitError", code: 1, err: "WARN device cleanup failed" });
  } });
  t.after(() => service.dispose());
  const result = await service.importFirst(destination, true);
  assert.equal(result.status, "partial");
  assert.equal(result.transcription.status, "failed");
  assert.equal(result.cleanup.status, "unconfirmed");
  assert.ok(result.cleanup.errors.some(error => error.message.includes("disconnect failed")));
});

test("cleanup failure alone prevents an overall successful workflow", async (t) => {
  t.after(recoverCleanupNotice);
  const destination = await temp(t);
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    await writeImportReport(args, { status: "succeeded", exitCode: 0 }, value => ({
      ...value, cleanup: { status: "unconfirmed", errors: [{ code: "DEVICE_CLEANUP_FAILED", message: "release unknown" }] },
    }));
    throw Object.assign(new Error("cleanup failed"), { name: "CliExitError", code: 1 });
  } });
  t.after(() => service.dispose());
  const result = await service.importFirst(destination, true);
  assert.equal(result.status, "partial");
  assert.equal(result.transcription.status, "succeeded");
  assert.equal(result.cleanup.status, "unconfirmed");
});

test("missing cleanup stays unconfirmed and missing integrity is rejected", async (t) => {
  t.after(recoverCleanupNotice);
  const destination = await temp(t);
  let missingIntegrity = false;
  const service = createRecorderService({ deviceAddress: "test-device" }, { execute: async (_cmd, args) => {
    await writeImportReport(args, undefined, value => {
      delete value.cleanup;
      if (missingIntegrity) delete value.imports[0].integrity;
      return value;
    });
    return { code: 0 };
  } });
  t.after(() => service.dispose());
  const result = await service.importFirst(destination);
  assert.equal(result.status, "partial");
  assert.equal(result.cleanup.status, "unconfirmed");
  missingIntegrity = true;
  await assert.rejects(service.importFirst(destination), { name: "CleanupError", message: /no device operation was started/ });
  await assert.rejects(service.importFirst(destination), error => error.name === "CleanupError" && error.cause.name === "ImportResultError");
});
