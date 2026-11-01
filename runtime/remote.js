import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

const initializers = [];
const codes = {
  TypeError: "recorder/config-or-argument", CliSpawnError: "recorder/spawn-failed",
  CliExitError: "recorder/cli-failed", AbortError: "gateway/cancelled",
  TimeoutError: "recorder/timeout", OutputLimitError: "recorder/output-limit",
  CleanupError: "recorder/cleanup-failed", ImportResultError: "recorder/import-result-invalid",
  SettingsError: "recorder/settings-failed",
  TranscriptionError: "recorder/transcription-failed",
};
async function call(operation, run) {
  try { return await run(); }
  catch (error) {
    const code = codes[error.name];
    if (!code) throw error;
    const diagnostic = error.name === "CliExitError" && error.err ? `: ${error.err.slice(-2048)}` : "";
    throw new RemoteError(code, `${operation}: ${error.message}${diagnostic}`, { operation }, { cause: error });
  }
}

export default class RecorderController extends TypertRemoteService {
  static inject = ["recorder", "typert"];
  constructor(ctx) {
    super(ctx, "recorderController", { namespace: "recorder" });
    for (const initialize of initializers) initialize.call(this);
  }
  scan(signal) { return call("scan", () => this.ctx.recorder.scan({ signal })); }
  getDevice(signal) { return call("getDevice", () => this.ctx.recorder.getDevice({ signal })); }
  saveDevice(address, signal) { return call("saveDevice", () => this.ctx.recorder.saveDevice(address, { signal })); }
  status(signal) { return call("status", () => this.ctx.recorder.status({ signal })); }
  list(signal) { return call("list", () => this.ctx.recorder.list({ signal })); }
  record(action, signal) {
    return call("record", () => action === "state"
      ? this.ctx.recorder.recordState({ signal }) : this.ctx.recorder.record(action, { signal }));
  }
  importFirst(options, signal) {
    return call("importFirst", () => this.ctx.recorder.importFirst(options?.outDir, options?.transcribe, { signal }));
  }
  transcribe(file, force, signal) { return call("transcribe", () => this.ctx.recorder.transcribe(file, { force, signal })); }
}

// Apply the public stage-3 decorator contract in plain JS; no transpiler helpers
// or private metadata keys. These initializers run after super(), as in TS output.
for (const name of ["scan", "status", "list", "record", "importFirst", "transcribe", "getDevice", "saveDevice"]) {
  Remote(RecorderController.prototype[name], {
    kind: "method", name, static: false, private: false,
    addInitializer: fn => initializers.push(fn),
  });
}
