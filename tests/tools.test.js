import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Tools, { TOOL_ABORTED_BEFORE_DISPATCH } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Skills from "@deepseek-ai/dsh-skill";
import * as plugin from "../index.js";
import { registerRecorderTools } from "../runtime/tools.js";

const integrity = { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 };
const cleanup = { status: "succeeded", errors: [] };

async function runtime(t, service) {
  const ctx = new Context();
  const mounts = [];
  t.after(async () => { for (const mount of mounts.reverse()) await mount.dispose(); });
  async function mount(value, config = {}) {
    const fiber = ctx.plugin(value, config);
    mounts.push(fiber);
    await fiber;
    return fiber;
  }
  await mount(SystemPrompt);
  await mount(Tools);
  await mount(Skills);
  if (service) await mount({ inject: ["tools"], apply: (ctx) => registerRecorderTools(ctx, service) });
  let sequence = 0;
  const execute = (name, args = {}, signal = new AbortController().signal) => ctx.tools.execute({
    callId: `recorder-test-${++sequence}`, name, arguments: args, signal,
  });
  return { ctx, mount, execute };
}

function stub() {
  const calls = [];
  const service = Object.fromEntries(["scan", "status", "list", "recordState", "record", "importFirst", "transcribe"].map(
    name => [name, async (...args) => { calls.push({ name, args }); return { code: 0, out: `output:${name}`, err: "" }; }],
  ));
  service.importFirst = async (...args) => {
    calls.push({ name: "importFirst", args });
    return { status: "succeeded", cleanup, import: { status: "succeeded", path: "test.wav", bytes: 10, sha256: "a".repeat(64), integrity },
      transcription: args[1] ? { status: "succeeded", exitCode: 0 } : { status: "not-requested" } };
  };
  return { calls, service };
}

test("real Cordis/DSH registry loads and disposes the six tools and Skill without duplicates", async (t) => {
  const { ctx, mount } = await runtime(t);
  const first = await mount(plugin);
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [
    "recorder_scan", "recorder_status", "recorder_list", "recorder_record", "recorder_import", "recorder_transcribe",
  ]);
  assert.equal((await ctx.skills.list()).length, 1);
  assert.match((await ctx.skills.get("recorder-card-bringup")).content, /^# AI recorder card/);
  await first.dispose();
  assert.equal(ctx.tools.schemas().length, 0);
  assert.equal((await ctx.skills.list()).length, 0);
  await mount(plugin);
  assert.equal(ctx.tools.schemas().length, 6);
  assert.equal((await ctx.skills.list()).length, 1);
});

test("tool schema validation rejects malformed calls before device access", async (t) => {
  const { calls, service } = stub();
  const { execute } = await runtime(t, service);
  for (const [name, args] of [
    ["recorder_record", {}], ["recorder_record", { action: "delete" }],
    ["recorder_import", { transcribe: "true" }], ["recorder_import", { outDir: 42 }],
    ["recorder_transcribe", {}], ["recorder_transcribe", { file: "test.wav", force: 1 }],
  ]) {
    const result = await execute(name, args);
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, "INVALID_ARGS");
  }
  assert.equal(calls.length, 0);
});

test("every tool maps arguments and signal correctly and returns a validated process result", async (t) => {
  const { calls, service } = stub();
  const { execute } = await runtime(t, service);
  for (const [name, args, method] of [
    ["recorder_scan", {}, "scan"], ["recorder_status", {}, "status"], ["recorder_list", {}, "list"],
    ...["start", "pause", "resume", "save"].map(action => ["recorder_record", { action }, "record"]),
    ["recorder_record", { action: "state" }, "recordState"],
    ["recorder_import", {}, "importFirst"],
    ["recorder_import", { outDir: "chosen folder", transcribe: true }, "importFirst"],
    ["recorder_transcribe", { file: "test.wav", force: true }, "transcribe"],
  ]) {
    const result = await execute(name, args);
    assert.equal(result.isError, false);
    if (method === "importFirst") {
      assert.equal(result.value.status, "succeeded");
      assert.equal(result.value.import.status, "succeeded");
      assert.equal(result.value.transcription.status, args.transcribe ? "succeeded" : "not-requested");
    } else {
      assert.equal(result.value.completion, "process-exited");
      assert.equal(result.value.exitCode, 0);
      assert.equal(result.value.stdout, `output:${method}`);
    }
    assert.deepEqual(JSON.parse(result.content[0].text), result.value);
    const call = calls.at(-1);
    assert.equal(call.name, method);
    assert.ok(call.args.at(-1).signal instanceof AbortSignal);
    if (method === "importFirst") assert.deepEqual(call.args.slice(0, 2), [args.outDir, args.transcribe === true]);
    if (method === "record") assert.equal(call.args[0], args.action);
    if (method === "transcribe") assert.equal(call.args[1].force, true);
  }
});

test("CLI failures remain error outcomes with stable codes, including incomplete-list diagnostics", async (t) => {
  let problem;
  const { service } = stub();
  service.list = async () => { throw problem; };
  const { execute } = await runtime(t, service);
  for (const [name, code] of [
    ["TypeError", "RECORDER_CONFIG_OR_ARGUMENT"], ["CliSpawnError", "RECORDER_SPAWN_FAILED"],
    ["CliExitError", "RECORDER_CLI_FAILED"], ["TimeoutError", "RECORDER_TIMEOUT"],
    ["OutputLimitError", "RECORDER_OUTPUT_LIMIT"], ["CleanupError", "RECORDER_CLEANUP_FAILED"],
  ]) {
    problem = Object.assign(new Error("operation failed"), { name, err: "List timed out; entries remain incomplete", code: 1 });
    const result = await execute("recorder_list");
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, code);
    assert.equal("value" in result, false);
    if (name === "CliExitError") assert.match(result.error.message, /remain incomplete/);
  }
});

test("DSH cancellation reaches the service and waits for it to settle", async (t) => {
  const { service } = stub();
  const ready = Promise.withResolvers();
  let released = false;
  service.scan = async ({ signal }) => {
    ready.resolve();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    released = true;
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  };
  const { execute } = await runtime(t, service);
  const controller = new AbortController();
  const pending = execute("recorder_scan", {}, controller.signal);
  await ready.promise;
  controller.abort();
  const result = await pending;
  assert.equal(released, true);
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "RECORDER_ABORTED");
});

test("pre-dispatch cancellation does not call any service method", async (t) => {
  const { calls, service } = stub();
  const { execute } = await runtime(t, service);
  const result = await execute("recorder_scan", {}, AbortSignal.abort());
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, TOOL_ABORTED_BEFORE_DISPATCH);
  assert.equal(calls.length, 0);
});

test("real tool dispatch reports missing device configuration without spawning", async (t) => {
  const { mount, execute } = await runtime(t);
  await mount(plugin);
  const result = await execute("recorder_status");
  assert.equal(result.isError, true);
  assert.equal(result.error.info.code, "RECORDER_CONFIG_OR_ARGUMENT");
  assert.match(result.error.message, /deviceAddress/);
});

test("plugin Config validates timeout and path types and preserves configured output", () => {
  assert.equal(plugin.Config({ outDir: "custom-output" }).outDir, "custom-output");
  for (const config of [{ python: 1 }, { deviceAddress: 42 }, { cliTimeoutMs: 0 }, { cliTimeoutMs: 1.5 }]) {
    assert.throws(() => plugin.Config(config));
  }
});

test("import exposes both transcription failure and cleanup warning as validated stages", async (t) => {
  const { service } = stub();
  service.importFirst = async () => ({
    status: "partial", cleanup: { status: "unconfirmed", errors: [{ code: "DEVICE_CLEANUP_FAILED", message: "Connection release is unconfirmed" }] }, import: { status: "succeeded", path: "retained.wav", bytes: 12, sha256: "b".repeat(64), integrity },
    transcription: { status: "failed", exitCode: 9, error: { code: "TRANSCRIPTION_FAILED", message: "quota" },
      retry: { tool: "recorder_transcribe", arguments: { file: "retained.wav" } } },
  });
  const { execute } = await runtime(t, service);
  const result = await execute("recorder_import", { transcribe: true });
  assert.equal(result.isError, false); // Dispatch succeeded; workflow status explicitly says partial.
  assert.equal(result.value.status, "partial");
  assert.equal(result.value.import.status, "succeeded");
  assert.equal(result.value.transcription.status, "failed");
  assert.equal(result.value.cleanup.status, "unconfirmed");
  assert.match(result.value.cleanup.errors[0].message, /release is unconfirmed/);
  assert.deepEqual(result.value.transcription.retry.arguments, { file: "retained.wav" });
  assert.deepEqual(JSON.parse(result.content[0].text), result.value);
});
