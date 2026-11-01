import { defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { createRecorderContract } from "./remote-contract.js";

const { diagnosticsSchema, parseDiagnostics } = createRecorderContract();

// A successful CLI process is not an end-to-end device/import/transcription verdict.
const processOutput = {
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      operation: { type: "string", required: true },
      completion: { type: "string", enum: ["operation-completed"], required: true },
      exitCode: { type: "integer", required: true },
      stdout: { type: "string", required: true },
      stderr: { type: "string", required: true },
      diagnostics: diagnosticsSchema,
    },
  },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

const importOutput = {
  schema: { type: "object", additionalProperties: false, properties: {
    diagnostics: diagnosticsSchema,
    status: { type: "string", enum: ["succeeded", "partial"], required: true },
    import: { type: "object", required: true, additionalProperties: false, properties: {
      status: { type: "string", enum: ["succeeded"], required: true },
      path: { type: "string", required: true }, bytes: { type: "integer", required: true },
      sha256: { type: "string", required: true },
      integrity: { type: "object", required: true, additionalProperties: false, properties: {
        status: { type: "string", enum: ["verified"], required: true },
        format: { type: "string", enum: ["wav-pcm"], required: true },
        channels: { type: "integer", required: true }, sampleRate: { type: "integer", required: true },
        bitsPerSample: { type: "integer", required: true }, frames: { type: "integer", required: true },
      } },
    } },
    cleanup: { type: "object", required: true, additionalProperties: false, properties: {
      status: { type: "string", enum: ["succeeded", "not-needed", "retained", "unconfirmed"], required: true },
      errors: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
        code: { type: "string", required: true }, message: { type: "string", required: true },
      } } },
    } },
    transcription: { type: "object", required: true, additionalProperties: false, properties: {
      status: { type: "string", enum: ["not-requested", "succeeded", "failed"], required: true },
      provider: { type: "string", enum: ["dsh", "doubao"] }, recognizer: { type: "string" },
      path: { type: "string" }, audioPath: { type: "string" }, audioSha256: { type: "string" },
      reused: { type: "boolean" }, fallbackReason: { type: "string" },
      exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
      error: { type: "object", additionalProperties: false, properties: {
        code: { type: "string", required: true }, message: { type: "string", required: true },
      } },
      retry: { type: "object", additionalProperties: false, properties: {
        tool: { type: "string", enum: ["recorder_transcribe"], required: true },
        arguments: { type: "object", required: true, additionalProperties: false, properties: { file: { type: "string", required: true } } },
      } },
    } },
  } },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

const errorCodes = {
  TypeError: "RECORDER_CONFIG_OR_ARGUMENT", CliSpawnError: "RECORDER_SPAWN_FAILED",
  CliExitError: "RECORDER_CLI_FAILED", AbortError: "RECORDER_ABORTED",
  TimeoutError: "RECORDER_TIMEOUT", OutputLimitError: "RECORDER_OUTPUT_LIMIT",
  CleanupError: "RECORDER_CLEANUP_FAILED", ImportResultError: "RECORDER_IMPORT_RESULT_INVALID",
  SettingsError: "RECORDER_SETTINGS_FAILED",
  TranscriptionError: "RECORDER_TRANSCRIPTION_FAILED",
  DeviceDisconnectedError: "RECORDER_DEVICE_DISCONNECTED", TransferInterruptedError: "RECORDER_TRANSFER_INTERRUPTED",
};
async function executeProcess(operation, run) {
  return executeOperation(operation, async () => {
    const result = await run();
    return { operation, completion: "operation-completed", exitCode: result.code,
      stdout: result.out, stderr: result.err, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
  });
}
async function executeOperation(operation, run) {
  try {
    const result = await run();
    return result?.diagnostics ? { ...result, diagnostics: parseDiagnostics(result.diagnostics) } : result;
  }
  catch (error) {
    const code = errorCodes[error.name];
    if (!code) throw error;
    const diagnostics = error.name === "CliExitError" && error.err ? `: ${error.err.slice(-2048)}` : "";
    const progress = error.diagnostics ? `; recorder diagnostics: ${JSON.stringify(parseDiagnostics(error.diagnostics))}` : "";
    throw new HarnessError(`${operation}: ${error.message}${diagnostics}${progress}`, code, { cause: error });
  }
}

// Mirrors @deepseek-ai/dsh-plugin-manager/tools: defineTool + ctx.tools.register.
// Host registration contributes global tools inherited by agent scopes, subject
// to their restrictions. Local scope tests cover inheritance/dispatch/filtering;
// the actual cordis session's effective catalog and presentation still need validation.
export function registerRecorderTools(ctx, service) {
  const output = processOutput;
  const connectionOutput = { schema: { type: "object", additionalProperties: false, properties: {
    diagnostics: diagnosticsSchema,
    status: { type: "string", required: true, enum: ["disconnected", "cleanup-unconfirmed", "connecting", "connected", "selection-required", "not-found"] },
    name: { type: "string", required: true }, address: { type: "string" }, message: { type: "string" },
    devices: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      name: { type: "string", required: true }, address: { type: "string", required: true },
    } } },
  } }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] };
  ctx.tools.register(defineTool({
    name: "recorder_connect",
    description: "Connect and hold the recorder BLE session. With no address, reconnect the saved card or scan and connect the only card. If selection-required, ask the user which returned device to use before calling with its address. An empty address clears the saved selection and scans again. Never guess an address or silently select among multiple cards.",
    parameters: { address: { type: "string", description: "Optional device identifier from scan results, selected by the user; empty string rescans." } },
    output: connectionOutput,
    execute: (args, exec) => executeOperation("connect", () => service.connect(args.address, { signal: exec.signal })),
    presentCall: args => ({ card: "generic", title: "Connect recorder card", kind: "other", rawInput: args }),
  }));
  ctx.tools.register(defineTool({
    name: "recorder_disconnect", description: "Release the persistent recorder BLE connection. Does not stop or save a recording.",
    parameters: {}, output: connectionOutput,
    execute: (_args, exec) => executeOperation("disconnect", () => service.disconnect({ signal: exec.signal })),
    presentCall: () => ({ card: "generic", title: "Disconnect recorder card", kind: "other", rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_scan",
    description: "Scan for AI recorder cards over BLE without device configuration. Releases an existing persistent connection first. Use recorder_connect with the user-selected identifier to connect and save it.",
    parameters: {},
    output,
    async execute(_args, exec) {
      return executeProcess("scan", () => service.scan({ signal: exec.signal }));
    },
    presentCall: () => ({ card: "generic", title: "Scan recorder cards", kind: "read", rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_status",
    description: "Read battery, capacity, and firmware status from the recorder card, reusing the Host connection when present.",
    parameters: {},
    output,
    async execute(_args, exec) {
      return executeProcess("status", () => service.status({ signal: exec.signal }));
    },
    presentCall: () => ({ card: "generic", title: "Recorder card status", kind: "read", rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_list",
    description: "List recordings stored on the recorder card.",
    parameters: {},
    output,
    async execute(_args, exec) {
      return executeProcess("list", () => service.list({ signal: exec.signal }));
    },
    presentCall: () => ({ card: "generic", title: "List recorder card recordings", kind: "read", rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_record",
    description: "Control recording (start, pause, resume, save) or read state. Remote start is unconfirmed on the tested firmware. A failed acknowledgement can leave the outcome unknown; inspect state and never retry automatically.",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "pause", "resume", "save", "state"], description: "Recording action; state reads the current recording state without changing it." },
    },
    output,
    async execute(args, exec) {
      return executeProcess(`record:${args.action}`, () => args.action === "state"
        ? service.recordState({ signal: exec.signal })
        : service.record(args.action, { signal: exec.signal }));
    },
    presentCall: (args) => ({ card: "generic", title: `Recorder ${args.action}`, kind: args.action === "state" ? "read" : "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_import",
    description: "Import one recording by its exact filename from recorder_list; omit filename for the first recording. Reuses the persistent Host BLE session: do not disconnect or run an external CLI first. For multiple user-selected recordings, call sequentially and stop on a device/transfer error; reconnect and explicitly retry the failed file from the beginning, never assume byte resume. Optionally transcribe through DSH speechToText (only an absent service falls back to Doubao cloud ASR). Inspect status: partial means audio is saved but transcription failed or cleanup is unconfirmed; retry transcription only using the returned audio path.",
    parameters: {
      filename: { type: "string", description: "Exact on-card name returned by recorder_list, not a local path, stem or comma-separated list. Omit to import the first recording." },
      outDir: { type: "string", description: "Destination directory relative to dataDir; defaults to the configured outDir, or archive/audio." },
      transcribe: { type: "boolean", description: "Transcribe after import using the configured provider; defaults to false. Doubao cloud fallback requires credentials and uploads audio." },
    },
    output: importOutput,
    async execute(args, exec) {
      return executeOperation("import", () => args.filename === undefined
        ? service.importFirst(args.outDir, args.transcribe === true, { signal: exec.signal })
        : service.importFile(args.filename, args.outDir, args.transcribe === true, { signal: exec.signal }));
    },
    presentCall: (args) => ({ card: "generic", title: "Import recorder card recording", kind: "other", rawInput: args }),
  }));

  ctx.tools.register(defineTool({
    name: "recorder_transcribe",
    description: "Transcribe an imported PCM WAV through DSH speechToText and archive Markdown with its audio hash. Only an absent speechToText service falls back to Doubao cloud ASR; existing provider failures never fall back. Reuses verified matching transcripts unless forced.",
    parameters: {
      file: { type: "string", required: true, description: "Audio file path relative to dataDir, or an absolute path returned by recorder_import." },
      force: { type: "boolean", description: "Re-run transcription even when a valid transcript exists; defaults to false." },
    },
    output: { schema: { type: "object", additionalProperties: false, properties: {
      status: { type: "string", enum: ["succeeded"], required: true },
      provider: { type: "string", enum: ["dsh", "doubao"], required: true }, recognizer: { type: "string", required: true },
      path: { type: "string", required: true }, audioPath: { type: "string", required: true }, audioSha256: { type: "string", required: true },
      reused: { type: "boolean", required: true }, fallbackReason: { type: "string" },
    } }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args, exec) {
      return executeOperation("transcribe", () => service.transcribe(args.file, { force: args.force === true, signal: exec.signal }));
    },
    presentCall: (args) => ({ card: "generic", title: "Transcribe recording", kind: "other", rawInput: args }),
  }));
}
