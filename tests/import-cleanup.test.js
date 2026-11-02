import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as tick } from "node:timers/promises";
import { createRecorderService, runProcess } from "../runtime/host-cli.js";
import { recoverCleanupNotice } from "./fixtures/cleanup-recovery.js";

const fixture = fileURLToPath(new URL("./fixtures/cli-child.mjs", import.meta.url));

for (const [label, contents, abort] of [
  ["missing", undefined, false], ["malformed", "{unfinished", false],
  ["unsupported", JSON.stringify({ version: 99, cleanup: { status: "succeeded", errors: [] },
    diagnostics: { version: 1, operation: "import", phase: "done", outcome: "succeeded", elapsedMs: 0,
      bytesReceived: 0, dataFrames: 0, attempts: 0, cleanup: "succeeded" } }), false],
  ["missing after cancellation", undefined, true],
]) {
  test(`terminated import with ${label} report warns queued callers before releasing BLE`, async t => {
    t.after(recoverCleanupNotice);
    const entered = Promise.withResolvers(), control = new AbortController();
    let dispatched = 0;
    const owner = createRecorderService({ deviceAddress: "test" }, { execute: async (_cmd, args, options) => {
      if (!args.includes("--result-file")) { dispatched++; return { code: 0 }; }
      if (contents !== undefined) await writeFile(args[args.indexOf("--result-file") + 1], contents);
      const running = runProcess(process.execPath, [fixture, "hold"], { ...options, timeoutMs: 300 });
      entered.resolve();
      return running;
    } });
    const other = createRecorderService({ deviceAddress: "test" }, { execute: async () => { dispatched++; return { code: 0 }; } });
    t.after(async () => { control.abort(); await owner.dispose(); await other.dispose(); });
    const imported = assert.rejects(owner.importFirst(undefined, false, { signal: control.signal }), error => {
      assert.equal(error.name, "CleanupError");
      assert.equal(error.cause.name, abort ? "AbortError" : "TimeoutError");
      assert.equal(error.cause.processStarted, true);
      assert.equal(error.diagnostics.cleanup, "unconfirmed");
      assert.equal(error.diagnostics.outcome, abort ? "cancelled" : "failed");
      return true;
    });
    await entered.promise;
    const warning = { name: "CleanupError", message: /no device operation was started/ };
    const waiting = [assert.rejects(owner.list(), warning), assert.rejects(other.list(), warning)];
    if (abort) control.abort();
    await Promise.all([imported, ...waiting]);
    assert.equal(dispatched, 0);
    assert.equal(owner.connectionState().status, "cleanup-unconfirmed");
    await other.list();
    assert.equal(dispatched, 1, "only an explicit retry after warning may dispatch");
  });
}

for (const mode of ["missing-executable", "invalid-cwd", "invalid-arguments", "cancel-before-spawn"]) {
  test(`proven ${mode} failure does not poison the import queue`, async t => {
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let lists = 0;
    const service = createRecorderService({ deviceAddress: "test" }, { execute: async (_cmd, args) => {
      if (!args.includes("--result-file")) { lists++; return { code: 0 }; }
      entered.resolve(); await finish.promise;
      if (mode === "cancel-before-spawn") return runProcess(process.execPath, [], { signal: AbortSignal.abort() });
      if (mode === "invalid-arguments") return runProcess(process.execPath, ["\0"]);
      return runProcess(mode === "missing-executable" ? "recorder-nonexistent-executable" : process.execPath,
        [fixture, "success"], mode === "invalid-cwd" ? { cwd: join(fixture, "missing") } : {});
    } });
    t.after(() => service.dispose());
    const failed = assert.rejects(service.importFirst(), error => {
      assert.equal(error.name, mode === "cancel-before-spawn" ? "AbortError" : "CliSpawnError");
      assert.equal(error.processStarted, false);
      assert.equal(error.diagnostics.cleanup, "not-needed");
      return true;
    });
    await entered.promise;
    const list = service.list();
    finish.resolve();
    await Promise.all([failed, list]);
    assert.equal(lists, 1);
    assert.equal(service.connectionState().status, "disconnected");
  });
}

test("missing report after termination failure retains the queue until process close", async t => {
  t.after(recoverCleanupNotice);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), closed = Promise.withResolvers();
  let dispatched = 0, settled = false;
  const service = createRecorderService({ deviceAddress: "test" }, { execute: async (_cmd, args) => {
    if (!args.includes("--result-file")) { dispatched++; return { code: 0 }; }
    entered.resolve(); await finish.promise;
    throw Object.assign(new Error("termination failed"), { name: "CleanupError", closed: closed.promise, processStarted: true });
  } });
  t.after(async () => { closed.resolve(); await service.dispose(); });
  const failed = assert.rejects(service.importFirst(), error => {
    assert.equal(error.name, "CleanupError");
    assert.equal(error.closed, closed.promise);
    return true;
  });
  await entered.promise;
  const queued = assert.rejects(service.list(), { name: "CleanupError" }).then(() => { settled = true; });
  finish.resolve(); await failed; await tick();
  assert.equal(settled, false);
  assert.equal(dispatched, 0);
  closed.resolve(); await queued;
  assert.equal(dispatched, 0);
});

for (const mode of ["exit-1", "deadline", "saved-audio"]) {
  test(`one-shot ${mode} reports unconfirmed release before dispatching queued BLE work`, async t => {
    t.after(recoverCleanupNotice);
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    let dispatched = 0;
    const execute = async (_command, args) => {
      dispatched++;
      if (!args.includes("--result-file")) return { code: 0, out: "", err: "" };
      entered.resolve();
      await finish.promise;
      const imports = mode === "saved-audio" ? [{ status: "succeeded",
        path: join(args[args.indexOf("--out") + 1], "test.wav"), bytes: 48, sha256: "a".repeat(64),
        integrity: { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 } }] : [];
      // Matches the adapter timeout report: cleanup is present, report.error is absent.
      await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify({ version: 2, imports, transcriptions: [],
        cleanup: { status: "unconfirmed", errors: [{ code: "DEVICE_CLEANUP_FAILED", message: "device re-advertising was not observed" }] },
        diagnostics: { version: 1, operation: "import", phase: "failed", failedPhase: "transfer", outcome: "failed",
          elapsedMs: 180000, bytesReceived: 48, dataFrames: 1, attempts: 1, cleanup: "unconfirmed" } }));
      throw Object.assign(new Error("adapter exited"), { name: "CliExitError", code: mode === "deadline" ? 124 : 1 });
    };
    const owner = createRecorderService({ deviceAddress: "test" }, { execute });
    const other = createRecorderService({ deviceAddress: "test" }, { execute });
    const later = createRecorderService({ deviceAddress: "test" }, { execute });
    t.after(async () => { finish.resolve(); for (const service of [owner, other, later]) await service.dispose(); });
    const importing = owner.importFirst();
    const imported = mode === "saved-audio" ? importing.then(result => {
      assert.equal(result.status, "partial");
      assert.equal(result.import.status, "succeeded");
      assert.equal(result.cleanup.status, "unconfirmed");
    }) : assert.rejects(importing, error => {
      assert.equal(error.name, "CleanupError");
      assert.equal(error.cause.name, mode === "deadline" ? "TimeoutError" : "CliExitError");
      assert.equal(error.cleanup.status, "unconfirmed");
      assert.equal(error.diagnostics.bytesReceived, 48);
      assert.match(error.message, /re-advertising was not observed/);
      return true;
    });
    await entered.promise;
    const warning = { name: "CleanupError", message: /re-advertising was not observed.*no device operation was started/ };
    const queued = [assert.rejects(owner.list(), warning), assert.rejects(other.list(), warning), assert.rejects(other.scan(), warning)];
    finish.resolve();
    await Promise.all([imported, ...queued]);
    assert.equal(dispatched, 1, "queued requests must not reach the executor while the report is read");
    assert.equal(owner.connectionState().status, "cleanup-unconfirmed");
    await assert.rejects(later.list(), warning);
    assert.equal(dispatched, 1, "a caller that has not seen the warning must see it before dispatch");
    await other.list(); // Explicit retry after delivery of the warning.
    assert.equal(dispatched, 2);
  });
}

test("one-shot deadline with confirmed cleanup keeps TimeoutError and allows queued work", async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let lists = 0;
  const service = createRecorderService({ deviceAddress: "test" }, { execute: async (_command, args) => {
    if (!args.includes("--result-file")) { lists++; return { code: 0, out: "", err: "" }; }
    entered.resolve(); await finish.promise;
    await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify({ version: 2, imports: [], transcriptions: [],
      cleanup: { status: "succeeded", errors: [] } }));
    throw Object.assign(new Error("deadline"), { name: "CliExitError", code: 124 });
  } });
  t.after(() => service.dispose());
  const failed = assert.rejects(service.importFirst(), { name: "TimeoutError" });
  await entered.promise;
  const list = service.list();
  finish.resolve();
  await Promise.all([failed, list]);
  assert.equal(lists, 1);
});
