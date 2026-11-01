import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import SpeechToText from "@deepseek-ai/dsh-experimental-speech-to-text";
import RecorderService from "../runtime/service.js";
import { createTranscriber } from "../runtime/transcription.js";

function wav(sample = 1) {
  const data = Buffer.alloc(48);
  data.write("RIFF"); data.writeUInt32LE(40, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(4, 40); data.writeInt16LE(sample, 44);
  return data;
}
async function setup(t, behavior = async () => ({ text: "测试内容", audioSeconds: .000125, inferenceSeconds: .01 })) {
  const directory = await mkdtemp(join(tmpdir(), "recorder-stt-"));
  const file = join(directory, "note20261011-161858.wav");
  await writeFile(file, wav());
  const ctx = new Context();
  const mounts = [];
  const speech = ctx.plugin(SpeechToText, { defaultProvider: "test-local", language: "auto" }); mounts.push(speech); await speech;
  let calls = 0;
  const registration = ctx.plugin({ inject: ["speechToText"], apply(child) {
    child.speechToText.register({ info: { id: "test-local", name: "Test", location: "host-local", languages: ["auto"] },
      transcribe: async (input, signal) => { calls++; return behavior(input, signal); } });
  } }); mounts.push(registration); await registration;
  const pipeline = createTranscriber({ dataDir: directory, getSpeech: () => ctx.speechToText,
    cli: { transcribe() { throw new Error("Unexpected cloud fallback"); } } });
  t.after(async () => { await pipeline.dispose(); for (const mount of mounts.reverse()) await mount.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { directory, file, ctx, mounts, pipeline, calls: () => calls };
}

test("official speech service resolves provider, archives provenance, reuses hashes and preserves forced/conflicting results", async t => {
  const env = await setup(t);
  const first = await env.pipeline.transcribe(env.file);
  assert.equal(first.provider, "dsh"); assert.equal(first.recognizer, "test-local"); assert.equal(first.reused, false);
  const markdown = await readFile(first.path, "utf8");
  assert.match(markdown, /provider: "dsh"/); assert.match(markdown, /2026-10-11 16:18:58/);
  assert.match(markdown, /speaker_source: "fallback"/); assert.match(markdown, /timeline: "none"/);
  assert.match(markdown, /说话人1：测试内容/);
  assert.equal((await env.pipeline.transcribe(env.file)).reused, true);
  assert.equal(env.calls(), 1);
  const forced = await env.pipeline.transcribe(env.file, { force: true });
  assert.notEqual(forced.path, first.path); assert.equal(await readFile(first.path, "utf8"), markdown);
  await writeFile(env.file, wav(2));
  const changed = await env.pipeline.transcribe(env.file);
  assert.notEqual(changed.path, first.path); assert.notEqual(changed.audioSha256, first.audioSha256);
});

test("corrupt/empty archives do not satisfy reuse and concurrent same-audio calls share a completed archive", async t => {
  const env = await setup(t);
  const first = await env.pipeline.transcribe(env.file);
  await writeFile(first.path, "---\naudio_sha256: \"" + first.audioSha256 + "\"\n---\n# Empty\n");
  const [a, b] = await Promise.all([env.pipeline.transcribe(env.file), env.pipeline.transcribe(env.file)]);
  assert.equal(env.calls(), 2); assert.equal(a.path, b.path);
  assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
  assert.match(await readFile(first.path, "utf8"), /# Empty/);
});

for (const moved of [false, true]) test(`cache lookup rejects changed or removed audio (different path=${moved})`, async t => {
  const env = await setup(t);
  const original = await env.pipeline.transcribe(env.file);
  const before = await readFile(original.path, "utf8");
  const target = moved ? join(env.directory, "copy.wav") : env.file;
  for (const mutation of ["changed", "truncated", "removed"]) {
    await writeFile(target, wav());
    const pipeline = createTranscriber({ dataDir: env.directory, cli: {}, getSpeech() {
      // resolve happens after the initial read/hash and before cache lookup.
      if (mutation === "removed") unlinkSync(target);
      else writeFileSync(target, mutation === "changed" ? wav(9) : wav().subarray(0, 46));
      return env.ctx.speechToText;
    } });
    try {
      await assert.rejects(pipeline.transcribe(target), { name: "TranscriptionError" });
      assert.equal(env.calls(), 1);
      assert.equal(await readFile(original.path, "utf8"), before);
      assert.deepEqual(await readdir(join(env.directory, "archive", "corpus")), [original.path.split(/[\\/]/u).at(-1)]);
    } finally { await pipeline.dispose(); }
  }
});

for (const removeOriginal of [false, true]) test(`same audio at new paths reuses text in separate current-path archives (move=${removeOriginal})`, async t => {
  const env = await setup(t);
  const first = await env.pipeline.transcribe(env.file);
  const original = await readFile(first.path, "utf8");
  const files = [join(env.directory, "note20300102-030405.wav"), join(env.directory, "copy.wav")];
  for (const file of files) await writeFile(file, wav());
  if (removeOriginal) await rm(env.file);
  const results = await Promise.all(files.map(file => env.pipeline.transcribe(file)));
  assert.equal(env.calls(), 1);
  assert.equal(new Set([first.path, ...results.map(x => x.path)]).size, 3);
  for (const [i, result] of results.entries()) {
    assert.equal(result.reused, true); assert.equal(result.audioPath, files[i]);
    const markdown = await readFile(result.path, "utf8");
    const fields = Object.fromEntries(markdown.split("---\n")[1].trim().split("\n").map(line => {
      const split = line.indexOf(": "); return [line.slice(0, split), JSON.parse(line.slice(split + 2))];
    }));
    assert.equal(fields.audio, files[i]);
    assert.equal(fields.transcription_source_audio, env.file);
    assert.equal(fields.recorded_at_source_audio, env.file);
    assert.equal(fields.recorded_at, "2026-10-11 16:18:58");
    assert.equal(fields.audio_sha256, createHash("sha256").update(await readFile(files[i])).digest("hex"));
    assert.ok(markdown.includes(`# ${files[i].split(/[\\/]/u).at(-1)}\n`));
    assert.match(markdown, /说话人1：测试内容/);
    assert.equal((await env.pipeline.transcribe(files[i])).path, result.path);
  }
  assert.equal(await readFile(first.path, "utf8"), original);
  if (!removeOriginal) assert.equal((await env.pipeline.transcribe(env.file)).path, first.path);
  assert.equal(env.calls(), 1);
});

test("empty recognition and invalid audio fail without publishing or falling back", async t => {
  const env = await setup(t, async () => ({ text: " ", audioSeconds: 1, inferenceSeconds: 0 }));
  await assert.rejects(env.pipeline.transcribe(env.file), /no text/);
  await writeFile(env.file, wav().subarray(0, 46));
  await assert.rejects(env.pipeline.transcribe(env.file), /complete canonical/);
  assert.deepEqual(await readdir(join(env.directory, "archive", "corpus")), []);
});

test("absent service falls back explicitly to Doubao and validates its artifact, not its logs", async t => {
  const env = await setup(t);
  let args, calls = 0;
  const pipeline = createTranscriber({ dataDir: env.directory, getSpeech: () => undefined, cli: {
    async transcribe(file, options) {
      calls++;
      args = options;
      const hash = createHash("sha256").update(await readFile(file)).digest("hex");
      await writeFile(join(options.outDir, "output.md"), `---\naudio_sha256: "${hash}"\nprovider: "doubao"\n---\n# title\n\n文本\n`);
      return { code: 0, out: "not parsed", err: "" };
    },
  } }); t.after(() => pipeline.dispose());
  const result = await pipeline.transcribe(env.file);
  assert.equal(args.provider, "doubao"); assert.equal(result.provider, "doubao"); assert.match(result.fallbackReason, /unavailable/);
  const original = await readFile(result.path, "utf8");
  const moved = join(env.directory, "moved.wav");
  await writeFile(moved, wav()); await rm(env.file);
  const rebound = await pipeline.transcribe(moved);
  assert.equal(calls, 1); assert.equal(rebound.reused, true); assert.equal(rebound.audioPath, moved);
  assert.notEqual(rebound.path, result.path);
  const markdown = await readFile(rebound.path, "utf8");
  assert.ok(markdown.includes(`audio: ${JSON.stringify(moved)}\n`));
  assert.match(markdown, /# moved\.wav\n/); assert.match(markdown, /文本/);
  assert.equal(await readFile(result.path, "utf8"), original);
  assert.equal((await readdir(join(env.directory, "archive", "corpus"))).filter(x => x.startsWith(".transcription-")).length, 0);
});

test("present but failing DSH provider never calls cloud fallback", async t => {
  const env = await setup(t, async () => { throw new Error("model not prepared"); });
  await assert.rejects(env.pipeline.transcribe(env.file), /model not prepared/);
});

test("input changes during inference never publish a transcript for stale bytes", async t => {
  let env;
  env = await setup(t, async () => {
    await writeFile(env.file, wav(3));
    return { text: "old bytes", audioSeconds: 1, inferenceSeconds: 0 };
  });
  await assert.rejects(env.pipeline.transcribe(env.file), /Audio changed/);
  assert.deepEqual(await readdir(join(env.directory, "archive", "corpus")), []);
});

test("explicit Doubao bypasses DSH but rejects missing or mismatched artifacts", async t => {
  const env = await setup(t);
  let wrong = false;
  const pipeline = createTranscriber({ dataDir: env.directory, provider: "doubao",
    getSpeech() { throw new Error("DSH must not be consulted"); }, cli: {
      async transcribe(_file, options) {
        if (wrong) await writeFile(join(options.outDir, "output.md"), '---\naudio_sha256: "wrong"\nprovider: "doubao"\n---\n# title\ntext\n');
        return { code: 0, out: "Success", err: "" };
      },
    } });
  t.after(() => pipeline.dispose());
  await assert.rejects(pipeline.transcribe(env.file), /no unique transcript/);
  wrong = true;
  await assert.rejects(pipeline.transcribe(env.file), /fingerprint\/provider mismatch/);
  assert.equal(env.calls(), 0);
  assert.deepEqual(await readdir(join(env.directory, "archive", "corpus")), []);
});

test("plugin disposal cancels local recognition and publishes no transcript", async t => {
  let started, cancelled = false;
  const ready = new Promise(resolve => { started = resolve; });
  const env = await setup(t, async (_input, signal) => {
    started(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    cancelled = true; signal.throwIfAborted();
  });
  const task = env.pipeline.transcribe(env.file);
  const rejected = assert.rejects(task, { name: "AbortError" });
  await ready; await env.pipeline.dispose(); await rejected;
  assert.equal(cancelled, true); assert.deepEqual(await readdir(join(env.directory, "archive", "corpus")), []);
});

test("shared recorder import invokes DSH after CLI cleanup and retains cleanup warning on recognition failure", async t => {
  const env = await setup(t, async () => { throw new Error("recognition failed"); });
  const mounted = env.ctx.plugin(RecorderService, { dataDir: env.directory, deviceAddress: "test-device" });
  env.mounts.push(mounted); await mounted;
  const cleanup = { status: "unconfirmed", errors: [{ code: "disconnect", message: "release unconfirmed" }] };
  env.ctx.recorder.cli.importFirst = async (_out, transcribe) => {
    assert.equal(transcribe, false);
    return { status: "partial", import: { status: "succeeded", path: env.file }, cleanup, transcription: { status: "not-requested" } };
  };
  const result = await env.ctx.recorder.importFirst(undefined, true);
  assert.equal(result.status, "partial"); assert.deepEqual(result.cleanup, cleanup);
  assert.equal(result.transcription.status, "failed"); assert.equal(result.transcription.retry.arguments.file, env.file);
  assert.equal((await readFile(env.file)).length, 48);
});
