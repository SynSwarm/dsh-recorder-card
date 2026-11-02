import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Tools from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { createRecorderService } from "../runtime/host-cli.js";
import { registerRecorderTools } from "../runtime/tools.js";
import { remoteRuntime } from "./fixtures/remote-runtime.js";

const large = { expectedBytes: 512044, bytesPerSecond: 1000 };
const imported = { status: "succeeded", path: "/test.wav", bytes: 48, sha256: "a".repeat(64),
  integrity: { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 } };
const report = (path, status = "succeeded") => ({ version: 2, imports: [{ ...imported, path }], transcriptions: [],
  cleanup: { status, errors: [] } });

test("over-budget estimate rejects before queueing or spawning and leaves later device work usable", async t => {
  let calls = 0, observed;
  const cli = createRecorderService({ deviceAddress: "test" }, {
    execute: async () => { calls++; return { code: 0 }; }, onDiagnostic: value => { observed = value; },
  });
  t.after(() => cli.dispose());
  await assert.rejects(cli.importFile("chosen.wav", undefined, false, { preflight: large }), error => {
    assert.equal(error.name, "ImportBudgetError");
    assert.match(error.message, /512044 B at 1000 B\/s/);
    assert.match(error.message, /656 s.*180 s.*666000/);
    assert.equal(error.diagnostics.attempts, 0);
    assert.equal(error.diagnostics.cleanup, "not-needed");
    assert.deepEqual(observed, error.diagnostics);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal(cli.connectionState().status, "disconnected");
  await cli.list(); assert.equal(calls, 1);
});

test("estimate respects operation budget boundary and increased timeout; omitted estimate stays compatible", async t => {
  for (const cliTimeoutMs of [190000, 666000]) {
    let calls = 0;
    const cli = createRecorderService({ deviceAddress: "test", cliTimeoutMs }, { execute: async (_cmd, args) => {
      calls++;
      await writeFile(args[args.indexOf("--result-file") + 1], JSON.stringify(report(join(args[args.indexOf("--out") + 1], "test.wav"))));
      return { code: 0 };
    } });
    t.after(() => cli.dispose());
    await cli.importFirst(undefined, false, { preflight: { expectedBytes: 132000, bytesPerSecond: 1000 } });
    if (cliTimeoutMs === 190000) {
      await assert.rejects(cli.importFirst(undefined, false, { preflight: { expectedBytes: 132001, bytesPerSecond: 1000 } }), { name: "ImportBudgetError" });
      assert.equal(calls, 1);
    } else {
      assert.equal((await cli.importFirst(undefined, false, { preflight: large })).status, "succeeded");
      assert.equal(calls, 2);
    }
    assert.equal((await cli.importFirst()).status, "succeeded");
  }
});

test("invalid estimates and impossible timeout advice never start an import", async t => {
  let calls = 0;
  const cli = createRecorderService({ deviceAddress: "test" }, { execute: async () => { calls++; return {}; } });
  t.after(() => cli.dispose());
  for (const preflight of [null, {}, { expectedBytes: 1 }, { ...large, bytesPerSecond: 0 },
    { ...large, expectedBytes: -1 }, { ...large, expectedBytes: 1.5 }, { ...large, bytesPerSecond: Infinity },
    { ...large, expectedBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...large, duration: 16 }]) {
    await assert.rejects(cli.importFirst(undefined, false, { preflight }), { name: "TypeError" });
  }
  await assert.rejects(cli.importFirst(undefined, false, { preflight: { expectedBytes: Number.MAX_SAFE_INTEGER, bytesPerSecond: 1 } }),
    { name: "ImportBudgetError", message: /exceeds the maximum configurable/ });
  await assert.rejects(cli.importFirst(undefined, false, { preflight: large, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("preflight on a persistent connection sends no import or disconnect request", async t => {
  const calls = [];
  let close;
  const cli = createRecorderService({}, { openConnection: () => ({
    closed: new Promise(resolve => { close = resolve; }),
    async request(method, args) {
      calls.push(method);
      return method === "connect" ? { status: "connected", name: "test" } : report(join(args.outDir, "test.wav"), "retained");
    }, async dispose() { calls.push("dispose"); close(); },
  }) });
  t.after(() => cli.dispose());
  await cli.connect();
  await assert.rejects(cli.importFirst(undefined, false, { preflight: large }), { name: "ImportBudgetError" });
  assert.deepEqual(calls, ["connect"]);
  assert.equal(cli.connectionState().status, "connected");
  await cli.importFile("chosen.wav", undefined, false, { preflight: { expectedBytes: 1000, bytesPerSecond: 1000 } });
  assert.deepEqual(calls, ["connect", "importFile"]);
});

test("real Agent and Remote entry points forward estimates and return the budget error", async t => {
  let calls = 0;
  const cli = createRecorderService({ deviceAddress: "test" }, { execute: async () => { calls++; return {}; } });
  t.after(() => cli.dispose());
  const { client, host } = await remoteRuntime(t, cli);
  for (const method of ["importFirst", "importFile"]) {
    const args = method === "importFirst" ? [{ preflight: large }] : ["chosen.wav", { preflight: large }];
    const result = await client.remote.recorder[method](...args);
    assert.equal(result.error.code, "recorder/import-budget-exceeded");
    assert.equal(result.error.details.diagnostics.cleanup, "not-needed");
  }
  const invalid = await host.typertGateway.dispatchRpc("recorder/importFirst", { args: { options: { preflight: { expectedBytes: 1 } } } });
  assert.equal(invalid.ok, false);
  const ctx = new Context(), mounts = [];
  t.after(async () => { for (const mount of mounts.reverse()) await mount.dispose(); });
  for (const plugin of [SystemPrompt, Tools, { inject: ["tools"], apply: ctx => registerRecorderTools(ctx, cli) }]) {
    const mount = ctx.plugin(plugin); mounts.push(mount); await mount;
  }
  for (const filename of [undefined, "chosen.wav"]) {
    const result = await ctx.tools.execute({ callId: "budget-test", name: "recorder_import",
      arguments: { ...(filename === undefined ? {} : { filename }), preflight: large }, signal: new AbortController().signal });
    assert.equal(result.error.info.code, "RECORDER_IMPORT_BUDGET_EXCEEDED");
    assert.match(result.error.message, /666000/);
  }
  assert.equal(calls, 0);
});
