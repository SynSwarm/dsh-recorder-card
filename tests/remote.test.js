import test from "node:test";
import assert from "node:assert/strict";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { remoteRuntime } from "./fixtures/remote-runtime.js";

const transcriptResult = { status: "succeeded", provider: "dsh", recognizer: "test", path: "corpus.md", audioPath: "saved-test.wav", audioSha256: "a".repeat(64), reused: false };

const processResult = { code: 0, out: "test output", err: "" };
const partial = {
  status: "partial", import: { status: "succeeded", path: "test.wav", bytes: 48, sha256: "a".repeat(64),
    integrity: { status: "verified", format: "wav-pcm", channels: 1, sampleRate: 16000, bitsPerSample: 16, frames: 2 } },
  transcription: { status: "failed", exitCode: 1, error: { code: "asr-failed", message: "offline" },
    retry: { tool: "recorder_transcribe", arguments: { file: "test.wav" } } },
  cleanup: { status: "unconfirmed", errors: [{ code: "disconnect-failed", message: "release unconfirmed" }] },
};

test("connection Remote preserves selection and retained import results through real codecs", async t => {
  const selection = { status: "selection-required", name: "", devices: [{ address: "test", name: "test" }] };
  const { client } = await remoteRuntime(t, {
    connect: async () => selection,
    connectionState: async () => ({ status: "connected", name: "test" }),
    disconnect: async () => ({ status: "disconnected", name: "" }),
    importFirst: async () => ({ ...partial, status: "succeeded", transcription: { status: "not-requested" }, cleanup: { status: "retained", errors: [] } }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify((await client.remote.recorder.connect(undefined)).value)), selection);
  assert.equal((await client.remote.recorder.connectionState()).value.status, "connected");
  assert.equal((await client.remote.recorder.importFirst(undefined)).value.cleanup.status, "retained");
  assert.equal((await client.remote.recorder.disconnect()).value.status, "disconnected");
});

test("Remote preserves cleanup-unconfirmed state and rejects device work with cleanup code", async t => {
  const warning = { status: "cleanup-unconfirmed", name: "", message: "idle cleanup failed" };
  const { client } = await remoteRuntime(t, {
    connectionState: async () => warning,
    disconnect: async () => warning,
    scan: async () => { throw Object.assign(new Error(warning.message), { name: "CleanupError" }); },
  });
  assert.equal((await client.remote.recorder.connectionState()).value.status, warning.status);
  assert.equal((await client.remote.recorder.disconnect()).value.message, warning.message);
  const result = await client.remote.recorder.scan();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "recorder/cleanup-failed");
});

test("official Client and Host Gateways dispatch all six methods and preserve partial stages", async t => {
  const received = [];
  const service = Object.fromEntries(["scan", "status", "list", "recordState", "record", "importFirst", "transcribe"]
    .map(name => [name, async (...args) => { received.push([name, args]); return name === "importFirst" ? partial : name === "transcribe" ? transcriptResult : processResult; }]));
  const { host, client } = await remoteRuntime(t, service);
  assert.deepEqual(remoteMethods(host.recorderController).map(x => x.method).sort(), ["scan", "status", "list", "record", "importFirst", "transcribe", "getDevice", "saveDevice", "connect", "disconnect", "connectionState"].sort());
  const remote = client.remote.recorder;
  const signal = new AbortController().signal;
  for (const name of ["scan", "status", "list"]) assert.equal((await remote[name](signal)).ok, true);
  await remote.record("state", signal);
  await remote.record("save", signal);
  const result = await remote.importFirst({ outDir: "audio", transcribe: true }, signal);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), partial);
  const transcript = await remote.transcribe("test.wav", false, signal);
  assert.equal(transcript.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(transcript.value)), transcriptResult);
  assert.deepEqual(received.map(x => x[0]), ["scan", "status", "list", "recordState", "record", "importFirst", "transcribe"]);
  assert.deepEqual(received[5][1].slice(0, 2), ["audio", true]);
  for (const [, args] of received) assert.ok(args.at(-1).signal instanceof AbortSignal);
  assert.deepEqual(received[6][1].slice(0, 1), ["test.wav"]);
});

test("Remote import preserves successful transcription provenance and reuse state", async t => {
  const complete = { ...partial, status: "succeeded", cleanup: { status: "succeeded", errors: [] },
    transcription: { ...transcriptResult, exitCode: 0 } };
  const { client } = await remoteRuntime(t, { importFirst: async () => complete });
  const result = await client.remote.recorder.importFirst({ transcribe: true });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), complete);
});

test("invalid Remote input fails before backend dispatch; errors and optional parameters survive", async t => {
  let count = 0;
  const { host, client } = await remoteRuntime(t, {
    record: async () => { count++; return processResult; },
    importFirst: async (outDir, transcribe) => { assert.equal(outDir, undefined); assert.equal(transcribe, undefined); return partial; },
    status: async () => { throw new TypeError("deviceAddress is required"); },
    scan: async () => ({ code: 0, out: 123, err: "" }),
  });
  for (const [endpoint, args] of [["record", { action: "delete" }], ["importFirst", { options: { transcribe: "true" } }],
    ["scan", { extra: true }], ["transcribe", { file: "" }]]) {
    const result = await host.typertGateway.dispatchRpc(`recorder/${endpoint}`, { args });
    assert.equal(result.ok, false);
  }
  assert.equal(count, 0);
  assert.equal((await client.remote.recorder.importFirst(undefined)).ok, true);
  const failed = await client.remote.recorder.status();
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "recorder/config-or-argument");
  assert.match(failed.error.message, /deviceAddress/);
  assert.equal((await client.remote.recorder.scan()).ok, false, "malformed backend output must fail");
});

for (const action of ["abort", "unmount"]) test(`Remote ${action} reaches Host cancellation and waits for cleanup`, async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let cleaned = false;
  const { client, disposeRemote } = await remoteRuntime(t, { async scan({ signal }) {
    started();
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 5)); cleaned = true;
    signal.throwIfAborted();
  } });
  const control = new AbortController();
  const result = client.remote.recorder.scan(control.signal);
  await ready;
  if (action === "abort") control.abort(); else await disposeRemote();
  const failure = await result;
  assert.equal(failure.ok, false);
  assert.equal(cleaned, true);
});

test("Host controller withdrawal makes existing Client methods unavailable", async t => {
  const { client, controller } = await remoteRuntime(t, { scan: async () => processResult });
  await controller.dispose();
  const result = await client.remote.recorder.scan();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "gateway/service-unavailable");
});
