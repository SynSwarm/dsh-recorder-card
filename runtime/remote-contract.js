// Shared, dependency-free Typert wire schemas. The public TypertSchema contract
// requires parse(value); Config continues to use Schemastery separately.
// scripts/sync-client-contract.mjs copies this factory into the browser entry.
export function createRecorderContract() {
  const fail = () => { throw new TypeError("Invalid recorder Remote value"); };
  const string = value => typeof value === "string" ? value : fail();
  const nonempty = value => string(value).trim() ? value : fail();
  const boolean = value => typeof value === "boolean" ? value : fail();
  const integer = value => Number.isSafeInteger(value) ? value : fail();
  const positive = value => integer(value) > 0 ? value : fail();
  const nonnegative = value => integer(value) >= 0 ? value : fail();
  const oneOf = (...values) => value => values.includes(value) ? value : fail();
  const optional = parse => value => value === undefined ? value : parse(value);
  const array = parse => value => Array.isArray(value) ? value.map(parse) : fail();
  const object = fields => value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    if (Object.keys(value).some(key => !Object.hasOwn(fields, key))) return fail();
    const result = {};
    for (const [key, parse] of Object.entries(fields)) {
      const parsed = parse(value[key]);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result;
  };
  const phases = ["queued", "starting", "scan", "connect", "status", "list", "importWrite", "transfer", "validate", "publish", "cleanup", "done", "failed"];
  const diagnosticEnums = { operation: ["cli", "scan", "connect", "disconnect", "status", "list", "record", "recordState", "import"],
    phase: phases, failedPhase: phases, outcome: ["running", "succeeded", "failed", "cancelled"],
    cleanup: ["pending", "retained", "succeeded", "not-needed", "unconfirmed"] };
  const metrics = ["elapsedMs", "bytesReceived", "dataFrames", "attempts", "queueMs", "snapshotAgeMs",
    "scanMs", "connectMs", "statusMs", "listMs", "importWriteMs", "transferMs", "validateMs", "publishMs", "cleanupMs",
    "firstFrameMs", "firstDataMs", "lastDataMs", "endFrameMs", "endCode",
    "frameIntervalSamples", "frameIntervalMedianMs", "frameIntervalP95Ms", "frameIntervalMaxMs", "stalls", "idleTimeoutMs", "dataIdleMs"];
  const requiredMetrics = ["elapsedMs", "bytesReceived", "dataFrames", "attempts"];
  const diagnostics = object({ version: oneOf(1),
    ...Object.fromEntries(Object.entries(diagnosticEnums).map(([key, values]) => [key, key === "failedPhase" ? optional(oneOf(...values)) : oneOf(...values)])),
    ...Object.fromEntries(metrics.map(key => [key, requiredMetrics.includes(key) ? nonnegative : optional(nonnegative)])),
  });
  // The Agent JSON schema and strict Remote parser share the same field inventory.
  const diagnosticsSchema = { type: "object", additionalProperties: false, properties: {
    version: { type: "integer", enum: [1], required: true },
    ...Object.fromEntries(Object.entries(diagnosticEnums).map(([key, values]) => [key, { type: "string", enum: values, ...(key === "failedPhase" ? {} : { required: true }) }])),
    ...Object.fromEntries(metrics.map(key => [key, { type: "integer", ...(requiredMetrics.includes(key) ? { required: true } : {}) }])),
  } };
  const error = object({ code: nonempty, message: string });
  const process = object({ code: integer, out: string, err: string, diagnostics: optional(diagnostics) });
  const device = object({ deviceAddress: string, source: oneOf("saved", "config", "none") });
  const connection = object({ status: oneOf("disconnected", "cleanup-unconfirmed", "connecting", "connected", "selection-required", "not-found"),
    name: string, address: optional(nonempty), message: optional(string), diagnostics: optional(diagnostics),
    devices: optional(array(object({ name: string, address: nonempty }))) });
  const transcriptFields = { provider: oneOf("dsh", "doubao"), recognizer: nonempty, path: nonempty,
    audioPath: nonempty, audioSha256: value => /^[a-f0-9]{64}$/.test(string(value)) ? value : fail(),
    reused: boolean, fallbackReason: optional(nonempty) };
  const transcript = object({ status: oneOf("succeeded"), ...transcriptFields });
  const imported = object({
    status: oneOf("succeeded", "partial"),
    diagnostics: optional(diagnostics),
    import: object({ status: oneOf("succeeded"), path: nonempty, bytes: positive,
      sha256: value => /^[a-f0-9]{64}$/.test(string(value)) ? value : fail(),
      integrity: object({ status: oneOf("verified"), format: oneOf("wav-pcm"),
        channels: positive, sampleRate: positive, bitsPerSample: positive, frames: positive }),
    }),
    transcription: object({ status: oneOf("not-requested", "succeeded", "failed"),
      ...Object.fromEntries(Object.entries(transcriptFields).map(([key, parse]) => [key, optional(parse)])),
      exitCode: optional(value => value === null ? null : integer(value)), error: optional(error),
      retry: optional(object({ tool: oneOf("recorder_transcribe"), arguments: object({ file: nonempty }) })),
    }),
    cleanup: object({ status: oneOf("succeeded", "not-needed", "retained", "unconfirmed"), errors: array(error) }),
  });
  const codec = (name, parse) => ({ mode: "strict", typeSymbol: `dsh-recorder-card#${name}`,
    create: () => ({ parse }), encode: value => parse(value), decode: value => parse(value) });
  const parameter = (name, parse, acceptsUndefined = false) => ({ name, wire: name, source: "json",
    codec: codec(name, parse), ...(acceptsUndefined ? { acceptsUndefined: true } : {}) });
  const definitions = {
    scan: [], status: [], list: [],
    connect: [parameter("address", optional(string), true)], disconnect: [], connectionState: [],
    record: [parameter("action", oneOf("state", "start", "pause", "resume", "save"))],
    importFirst: [parameter("options", optional(object({ outDir: optional(nonempty), transcribe: optional(boolean) })), true)],
    importFile: [parameter("filename", nonempty), parameter("options", optional(object({ outDir: optional(nonempty), transcribe: optional(boolean) })), true)],
    transcribe: [parameter("file", nonempty), parameter("force", optional(boolean), true)],
    getDevice: [],
    saveDevice: [parameter("address", string)],
  };
  const descriptors = Object.entries(definitions).map(([method, parameters]) => ({
    id: `dsh-recorder-card#recorder/${method}`, service: "recorderController", namespace: "recorder", method,
    invocation: { kind: "direct" }, parameters, cancellation: { parameter: "signal" },
    result: method === "transcribe" ? codec("TranscriptResult", transcript)
      : ["connect", "disconnect", "connectionState"].includes(method) ? codec("ConnectionState", connection)
      : method === "getDevice" || method === "saveDevice" ? codec("DeviceSettings", device)
      : codec(["importFirst", "importFile"].includes(method) ? "ImportResult" : "ProcessResult", ["importFirst", "importFile"].includes(method) ? imported : process),
  }));
  return { package: "dsh-recorder-card", descriptors, parseDiagnostics: diagnostics, diagnosticsSchema };
}
