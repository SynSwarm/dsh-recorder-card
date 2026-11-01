// The `recorder` Cordis Service: one shared device queue wrapping the pinned CLI.
//
// Both the Agent tools (runtime/tools.js) and the Client Remote (runtime/remote.js)
// inject this service, so browser-card and Agent-tool operations serialize on the
// same BLE owner instead of racing each other. Mirrors the Service pattern of
// @deepseek-ai/dsh-skill (super(ctx, "name")).
import { Service } from "@deepseek-ai/cordis";
import { createRecorderService } from "./host-cli.js";
import { createDeviceSettings } from "./device-settings.js";
import { createTranscriber } from "./transcription.js";

export class RecorderService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, "recorder");
    const current = { ...config };
    this.cli = createRecorderService(current);
    this.settings = createDeviceSettings(this.cli.dataDir, current);
    let speech;
    ctx.inject(["speechToText"], child => {
      speech = child.speechToText;
      return () => { speech = undefined; };
    });
    this.transcription = createTranscriber({ dataDir: this.cli.dataDir, cli: this.cli,
      provider: config.transcriptionProvider ?? "dsh", timeoutMs: config.cliTimeoutMs ?? 190000,
      getSpeech: () => speech });
    ctx.effect(() => async () => {
      await Promise.all([this.cli.dispose(), this.settings.dispose(), this.transcription.dispose()]);
    }, "recorder-card: CLI and settings cancellation");
  }

  scan(options) { return this.cli.scan(options); }
  getDevice(options) { return this.settings.getDevice(options); }
  saveDevice(address, options) { return this.settings.saveDevice(address, options); }
  async status(options) { await this.getDevice(options); return this.cli.status(options); }
  async list(options) { await this.getDevice(options); return this.cli.list(options); }
  async recordState(options) { await this.getDevice(options); return this.cli.recordState(options); }
  async record(action, options) { await this.getDevice(options); return this.cli.record(action, options); }
  async importFirst(outDir, transcribe = false, options) {
    if (typeof transcribe !== "boolean") throw new TypeError("transcribe must be boolean");
    await this.getDevice(options);
    // Import/cleanup completes and releases BLE before any ASR backend is called.
    const result = await this.cli.importFirst(outDir, false, options);
    if (!transcribe) return result;
    try {
      const transcript = await this.transcribe(result.import.path, options);
      result.transcription = { status: "succeeded", exitCode: 0, ...transcript };
    } catch (error) {
      result.status = "partial";
      result.transcription = { status: "failed", exitCode: null,
        error: { code: error.name === "AbortError" ? "TRANSCRIPTION_CANCELLED" : "TRANSCRIPTION_FAILED", message: error.message },
        retry: { tool: "recorder_transcribe", arguments: { file: result.import.path } } };
    }
    return result;
  }
  transcribe(file, options) { return this.transcription.transcribe(file, options); }
}

export default RecorderService;
