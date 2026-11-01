import { readFile, stat, mkdir, readdir, mkdtemp, writeFile, link, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

const digest = value => createHash("sha256").update(value).digest("hex");
const failure = message => Object.assign(new Error(message), { name: "TranscriptionError" });
const MAX_BYTES = 64 * 1024 * 1024;

// This first integration accepts exactly the PCM format consumed by DSH's
// speech service. No implicit resampling, synthetic segment times or diarization.
export function waveSeconds(data) {
  if (data.length < 46 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 16) !== "WAVEfmt " ||
      data.readUInt32LE(4) !== data.length - 8 || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 ||
      data.readUInt16LE(22) !== 1 || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000 ||
      data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16 || data.toString("ascii", 36, 40) !== "data" ||
      data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2) {
    throw failure("Transcription requires a complete canonical 16 kHz mono PCM16 WAV");
  }
  return (data.length - 44) / 32000;
}

function recordingTime(file) {
  const match = /(?:^|\D)(\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})(?:\D|$)/u.exec(basename(file));
  if (!match) return "";
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return "";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function parseArchive(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = /^(\w+): (.+)$/u.exec(line);
    if (field) {
      try { meta[field[1]] = JSON.parse(field[2]); } catch { meta[field[1]] = field[2]; }
    }
  }
  return { meta, body: match[2] };
}

export function createTranscriber({ dataDir, provider = "dsh", timeoutMs = 190000, getSpeech, cli }) {
  if (!["dsh", "doubao"].includes(provider)) throw new TypeError("Unsupported transcriptionProvider");
  const corpus = join(dataDir, "archive", "corpus");
  const lifetime = new AbortController();
  const pending = new Set();
  const tails = new Map();
  async function transcribe(file, { force = false, signal } = {}) {
    if (typeof file !== "string" || !file.trim() || file.includes("\0") || typeof force !== "boolean") throw new TypeError("Invalid transcription arguments");
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const run = async () => {
      combined.throwIfAborted();
      const audioPath = resolve(dataDir, file);
      if ((await stat(audioPath)).size > MAX_BYTES) throw failure("Audio exceeds the 64 MiB transcription limit");
      const audio = await readFile(audioPath, { signal: combined });
      if (audio.length > MAX_BYTES) throw failure("Audio exceeds the 64 MiB transcription limit");
      const seconds = waveSeconds(audio), audioSha256 = digest(audio);
      const speech = provider === "dsh" ? getSpeech() : undefined;
      const selected = speech ? "dsh" : "doubao";
      const fallbackReason = provider === "dsh" && !speech ? "speechToText service unavailable" : undefined;
      // An existing service's resolution/readiness/inference failure never falls back.
      const spec = speech?.resolve({ audio });
      const recognizer = spec?.provider?.info?.id ?? "doubao";
      const language = spec?.language ?? "auto";
      const key = `${audioSha256}-${digest(JSON.stringify([selected, recognizer, language, 1])).slice(0, 16)}`;
      const previous = tails.get(key) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        combined.throwIfAborted();
        await mkdir(corpus, { recursive: true });
        const result = (path, reused) => ({ status: "succeeded", provider: selected, recognizer, path,
          audioPath, audioSha256, reused, ...(fallbackReason ? { fallbackReason } : {}) });
        const verifyAudio = async () => {
          combined.throwIfAborted();
          if ((await stat(audioPath)).size > MAX_BYTES || digest(await readFile(audioPath, { signal: combined })) !== audioSha256) {
            throw failure("Audio changed during transcription or cache lookup; no result confirmed");
          }
          combined.throwIfAborted();
        };
        const publish = async (meta, body, reused) => {
          const content = `---\n${Object.entries({ ...meta, body_sha256: digest(body) }).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
          const temporary = join(corpus, `.transcript-${randomUUID()}.tmp`);
          let path = join(corpus, `${key}.md`);
          try {
            await writeFile(temporary, content, { flag: "wx", mode: 0o600, signal: combined });
            // Check the current path after all cache/archive I/O, immediately before publication.
            await verifyAudio();
            try { await link(temporary, path); }
            catch (error) {
              if (error.code !== "EEXIST") throw error;
              path = join(corpus, `${key}-${randomUUID()}.md`);
              await link(temporary, path);
            }
            return result(path, reused);
          } finally { await rm(temporary, { force: true }); }
        };
        if (!force) {
          let alternate;
          const candidates = await Promise.all((await readdir(corpus)).filter(name => name.startsWith(key) && name.endsWith(".md"))
            .map(async name => ({ path: join(corpus, name), mtime: (await stat(join(corpus, name))).mtimeMs })));
          for (const entry of candidates.sort((a, b) => b.mtime - a.mtime)) {
            const saved = parseArchive(await readFile(entry.path, { encoding: "utf8", signal: combined }));
            if (saved?.meta.audio_sha256 === audioSha256 && saved.meta.provider === selected && saved.meta.recognizer === recognizer &&
                saved.meta.language === language && saved.meta.text_length > 0 && saved.body.trim() &&
                saved.meta.body_sha256 === digest(saved.body) && typeof saved.meta.audio === "string" &&
                /^\s*# [^\r\n]*\r?\n/u.test(saved.body)) {
              if (saved.meta.audio === audioPath) {
                await verifyAudio();
                return result(entry.path, true);
              }
              alternate ??= saved;
            }
          }
          if (alternate) {
            // The old file is an immutable provenance record, not the current audio link.
            // Keep its recognized text/timeline; a renamed file must not shift the timeline.
            const meta = { ...alternate.meta, audio: audioPath,
              transcription_source_audio: alternate.meta.transcription_source_audio ?? alternate.meta.audio };
            if (meta.recorded_at_source === "filename") {
              meta.recorded_at_source_audio = alternate.meta.recorded_at_source_audio ?? alternate.meta.audio;
            }
            const body = alternate.body.replace(/^(\s*# )[^\r\n]*(\r?\n)/u,
              (_match, prefix, newline) => prefix + basename(audioPath).replace(/[\r\n]/gu, " ") + newline);
            return publish(meta, body, true);
          }
        }
        let text, upstreamTimeline = "none";
        if (speech) {
          const transcript = await speech.transcribe(spec, combined);
          if (typeof transcript?.text !== "string" || !Number.isFinite(transcript.audioSeconds) || transcript.audioSeconds < 0 ||
              !Number.isFinite(transcript.inferenceSeconds) || transcript.inferenceSeconds < 0) throw failure("DSH returned an invalid transcript");
          text = transcript.text.trim();
        } else {
          const staging = await mkdtemp(join(corpus, ".transcription-"));
          try {
            await cli.transcribe(audioPath, { force: true, provider: "doubao", outDir: staging, signal: combined });
            const files = (await readdir(staging)).filter(name => name.endsWith(".md"));
            if (files.length !== 1) throw failure("Doubao produced no unique transcript artifact");
            const saved = parseArchive(await readFile(join(staging, files[0]), { encoding: "utf8", signal: combined }));
            if (saved?.meta.audio_sha256 !== audioSha256 || saved.meta.provider !== "doubao") throw failure("Doubao transcript fingerprint/provider mismatch");
            upstreamTimeline = ["wall-clock", "relative", "none"].includes(saved.meta.timeline) ? saved.meta.timeline : "unknown";
            text = saved.body.replace(/^\s*# [^\r\n]*(?:\r?\n|$)/u, "").trim();
          } finally { await rm(staging, { recursive: true, force: true }); }
        }
        combined.throwIfAborted();
        if (!text) throw failure("Speech recognition returned no text; audio retained");
        const recordedAt = recordingTime(audioPath);
        const body = `\n# ${basename(audioPath).replace(/[\r\n]/gu, " ")}\n\n` +
          (selected === "dsh" ? `> 说话人1为默认标签；没有分段时间戳。${recordedAt ? "起始时间根据文件名推算。" : "录音起始时间未知。"}\n\n${recordedAt ? `[${recordedAt}] ` : ""}说话人1：` : "") + text + "\n";
        const meta = { schema_version: 1, audio: audioPath, audio_sha256: audioSha256, provider: selected, recognizer,
          language, audio_seconds: seconds, recorded_at: recordedAt, recorded_at_source: recordedAt ? "filename" : "unknown",
          timeline: selected === "dsh" ? "none" : upstreamTimeline, speaker_source: selected === "dsh" ? "fallback" : "upstream-unverified",
          text_length: text.length, body_sha256: digest(body) };
        return publish(meta, body, false);
      });
      tails.set(key, work);
      try { return await work; } finally { if (tails.get(key) === work) tails.delete(key); }
    };
    const task = run().catch(error => {
      if (combined.aborted) throw combined.reason;
      if (error.name === "TypeError" || error.name === "TranscriptionError") throw error;
      throw failure(`Transcription failed; audio retained: ${error.message}`);
    });
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  }
  return { transcribe, async dispose() { lifetime.abort(); await Promise.allSettled([...pending]); } };
}
