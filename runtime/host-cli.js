import { spawn, execFile } from "node:child_process";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "./connection.js";
import { createRecorderContract } from "./remote-contract.js";

const { parseDiagnostics, parsePreflight } = createRecorderContract();

const DEFAULT_TIMEOUT_MS = 190_000; // Adapter: 180 seconds + disconnect/startup allowance.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function failure(name, message, details = {}) {
  return Object.assign(new Error(message), { name, ...details });
}

function cancelled() {
  return failure("AbortError", "Recorder operation cancelled; device outcome may be unknown");
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${label} must be a positive integer no greater than 2147483647`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL characters`);
  }
  return value;
}

async function terminateTree(child) {
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    await new Promise((done, reject) => {
      execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 }, (error) => error ? reject(error) : done());
    });
  } else {
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    killGroup("SIGTERM");
    // Descendants may ignore SIGTERM; retain the slot through escalation.
    await new Promise((done) => setTimeout(done, 1_000));
    killGroup("SIGKILL");
  }
}

// Settlement waits for close (including stdio) and the tree-termination attempt.
// Cancellation is process termination, not a firmware stop/save or rollback.
export function runProcess(command, args, {
  cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
  terminate = terminateTree,
} = {}) {
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(maxOutputBytes, "maxOutputBytes");
  if (signal?.aborted) return Promise.reject(Object.assign(cancelled(), { processStarted: false }));
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      });
    } catch (cause) {
      reject(failure("CliSpawnError", "Could not start recorder CLI; check the executable and launch arguments", { cause, processStarted: false }));
      return;
    }
    const stdout = [], stderr = [];
    let bytes = 0, problem, timer, isClosed = false;
    let markClosed;
    const closed = new Promise((done) => { markClosed = done; });
    let termination = Promise.resolve();
    const stop = (reason) => {
      if (problem) return;
      problem = reason;
      clearTimeout(timer);
      if (!child.pid) return; // Spawn failure: close still follows error.
      termination = Promise.resolve().then(() => terminate(child)).catch((cause) => {
        if (!isClosed) {
          // Report failure promptly, but keep the device queue occupied until close.
          problem = failure("CleanupError", "Could not terminate recorder CLI; device queue remains blocked until it exits", {
            cause, operationError: reason, closed, processStarted: true,
          });
          reject(problem);
        }
      });
    };
    const onAbort = () => stop(cancelled());
    const capture = (chunks, chunk) => {
      if (problem) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        stop(failure("OutputLimitError", "Recorder CLI output exceeded the capture limit"));
      } else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.on("error", (error) => { problem ??= failure("CliSpawnError", "Could not start recorder CLI. Install Python 3.11+ and configure the plugin's python executable; also check repoRoot if overriding bundled sources", { cause: error }); });
    child.on("close", async (code, exitSignal) => {
      isClosed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await termination;
      markClosed();
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (problem) reject(Object.assign(problem, { code, exitSignal, out, err, processStarted: Boolean(child.pid) }));
      else if (code !== 0) reject(failure("CliExitError", `Recorder CLI exited ${code ?? exitSignal}`, { code, exitSignal, out, err, processStarted: Boolean(child.pid) }));
      else resolveResult({ code, out, err });
    });
    timer = setTimeout(() => stop(failure("TimeoutError", "Recorder CLI timed out; device outcome may be unknown")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

// Shared by service instances in this loaded module. Scans also take the slot.
// External CLI processes, other Node Hosts and browser connections are not locked.
const deviceQueue = [];
let deviceBusy = false;
let cleanupNotice;
let cleanupEpoch = 0;
function pump() {
  if (deviceBusy || !deviceQueue.length) return;
  const entry = deviceQueue.shift();
  entry.signal.removeEventListener("abort", entry.abort);
  deviceBusy = true;
  Promise.resolve().then(() => {
    if (entry.signal.aborted) throw cancelled();
    return entry.execute();
  }).then(entry.resolve, async (error) => {
    entry.reject(error);
    // Killing failed: callers can see the error without starting a competing CLI.
    await error.closed;
  }).finally(() => { deviceBusy = false; pump(); });
}

function enqueueDevice(execute, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolveResult, reject) => {
    const entry = { execute, signal, resolve: resolveResult, reject };
    entry.abort = () => {
      const index = deviceQueue.indexOf(entry);
      if (index >= 0) deviceQueue.splice(index, 1);
      reject(cancelled());
    };
    deviceQueue.push(entry);
    signal.addEventListener("abort", entry.abort, { once: true });
    pump();
  });
}

function cleanupOutcome(cleanup) {
  if (cleanup && ["succeeded", "not-needed", "retained"].includes(cleanup.status) &&
      Array.isArray(cleanup.errors) && cleanup.errors.length === 0) return cleanup;
  return {
    status: "unconfirmed",
    errors: [{ code: "DEVICE_CLEANUP_UNCONFIRMED", message: "Device connection release is unconfirmed; inspect the device before another BLE operation" },
      ...(Array.isArray(cleanup?.errors) ? cleanup.errors.filter(error => typeof error?.code === "string" && typeof error?.message === "string") : [])],
  };
}

function importOutcome(report, outDir, requested) {
  const audio = report?.imports?.[0];
  const local = typeof audio?.path === "string" ? relative(outDir, audio.path) : "";
  if (report?.version !== 2 || report.imports?.length !== 1 || audio?.status !== "succeeded" ||
      !isAbsolute(audio.path) || !local || local.startsWith("..") || isAbsolute(local) ||
      !Number.isSafeInteger(audio.bytes) || audio.bytes <= 0 || !/^[a-f0-9]{64}$/.test(audio.sha256) ||
      audio.integrity?.status !== "verified" || audio.integrity?.format !== "wav-pcm" ||
      !["channels", "sampleRate", "bitsPerSample", "frames"].every(key => Number.isSafeInteger(audio.integrity[key]) && audio.integrity[key] > 0) ||
      !Array.isArray(report.transcriptions)) {
    throw failure("ImportResultError", "Import result is missing or invalid; inspect the output directory before retrying");
  }
  const transcript = report.transcriptions[0];
  if ((!requested && report.transcriptions.length !== 0) || (requested &&
      (report.transcriptions.length !== 1 || transcript.audioPath !== audio.path ||
       !["succeeded", "failed"].includes(transcript.status) ||
       !(transcript.exitCode === null || Number.isInteger(transcript.exitCode)) ||
       (transcript.status === "succeeded" && transcript.exitCode !== 0) ||
       (transcript.status === "failed" && (typeof transcript.error?.code !== "string" || typeof transcript.error?.message !== "string"))))) {
    throw failure("ImportResultError", `Transcription outcome unconfirmed; imported audio retained at ${audio.path}`, { audioPath: audio.path });
  }
  const transcription = requested ? { status: transcript.status, exitCode: transcript.exitCode } : { status: "not-requested" };
  if (transcription.status === "failed") {
    transcription.error = transcript.error;
    transcription.retry = { tool: "recorder_transcribe", arguments: { file: audio.path } };
  }
  const cleanupResult = cleanupOutcome(report.cleanup);
  return { status: transcription.status === "failed" || cleanupResult.status === "unconfirmed" ? "partial" : "succeeded", import: audio, transcription, cleanup: cleanupResult,
    ...(report.diagnostics ? { diagnostics: parseDiagnostics(report.diagnostics) } : {}) };
}

export function createRecorderService(config = {}, { execute = runProcess, openConnection = createConnection, onDiagnostic } = {}) {
  const python = text(config.python ?? "python", "python");
  const bundledRoot = fileURLToPath(new URL("../vendor/upstream/", import.meta.url));
  const repoRoot = resolve(text(config.repoRoot === "" ? bundledRoot : config.repoRoot ?? bundledRoot, "repoRoot"));
  const dataDir = resolve(text(config.dataDir ?? join(homedir(), ".dsh-recorder-card"), "dataDir"));
  const outsideSource = (path) => {
    for (const source of [repoRoot, bundledRoot]) {
      const local = relative(source, path);
      if (!local || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))) {
        throw new TypeError("Data paths must be outside the CLI source directory; configure dataDir/outDir");
      }
    }
    return path;
  };
  outsideSource(dataDir);
  const timeoutMs = positiveInteger(config.cliTimeoutMs ?? DEFAULT_TIMEOUT_MS, "cliTimeoutMs");
  // Keep the Host watchdog outside the Python budget so normal deadlines can
  // still disconnect and publish a final report (190s -> 180s by default).
  const operationSeconds = (timeoutMs - Math.min(10_000, timeoutMs / 2)) / 1000;
  const adapter = fileURLToPath(new URL("./recorder_cli.py", import.meta.url));
  const lifetime = new AbortController();
  const pending = new Set();
  const unfinished = new Set();
  let connection, connecting, lease, connectionControl;
  let connectionState = { status: "disconnected", name: "" };
  let notifiedCleanupEpoch = 0;
  async function observe(value) {
    if (value?.diagnostics) {
      try { value.diagnostics = parseDiagnostics(value.diagnostics); }
      catch { delete value.diagnostics; return value; }
      try { await onDiagnostic?.(value.diagnostics); }
      catch (error) { console.warn("Recorder diagnostics could not be saved:", error.code || error.name); }
    }
    return value;
  }
  async function capture(promise) {
    try { return await observe(await promise); }
    catch (error) { await observe(error); throw error; }
  }
  // A cleanup warning must reach every affected caller before more BLE work.
  // Capture at submission: all requests already queued before notification fail,
  // rather than silently executing after the first rejected request in a batch.
  function queueDevice(execute, signal) {
    const observed = notifiedCleanupEpoch;
    return enqueueDevice(() => {
      if (cleanupNotice && observed < cleanupNotice.epoch) {
        notifiedCleanupEpoch = cleanupNotice.epoch;
        throw failure("CleanupError", `${cleanupNotice.message}; no device operation was started. Check the device before explicitly retrying`);
      }
      return execute();
    }, signal);
  }
  const deviceArgs = (...args) => {
    const address = text(config.deviceAddress, "deviceAddress").trim();
    if (address.startsWith("-")) throw new TypeError("deviceAddress cannot start with '-'");
    return ["--address", address, ...args];
  };
  function run(script, args, options = {}, device = true, complete) {
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    if (signal.aborted) return Promise.reject(cancelled());
    const submitted = performance.now();
    const invoke = async () => {
      options.onDispatch?.(Math.max(0, Math.round(performance.now() - submitted)));
      let result, processError;
      try { result = await execute(python, ["-B", script, ...args], { cwd: repoRoot, signal, timeoutMs }); }
      catch (error) {
        if (device && error.name === "CliExitError" && error.code === 124) {
          error.name = "TimeoutError";
          error.message = "Recorder adapter operation budget expired; inspect cleanup and explicitly retry";
        }
        processError = error;
      }
      // Report validation and cleanup notification must finish while the BLE
      // lease is still held, before any queued request can reach its executor.
      if (complete) return complete(result, processError);
      if (processError) throw processError;
      return result;
    };
    const promise = device ? queueDevice(invoke, signal) : Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return invoke();
    });
    pending.add(promise);
    const forget = () => pending.delete(promise);
    promise.then(forget, (error) => {
      forget();
      if (error.closed) {
        unfinished.add(error.closed);
        error.closed.then(() => unfinished.delete(error.closed));
      }
    });
    return promise;
  }
  const bringup = (args, options, adapterArgs = [], complete) => run(adapter, ["--repo-root", repoRoot, "--data-dir", dataDir,
    "--timeout", String(operationSeconds), ...adapterArgs, "--", ...args], options, true, complete);
  const connectedCall = (method, args, options = {}) => capture(connection.request(method, args,
    { signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal }));
  async function release() {
    const released = await capture(Promise.resolve().then(() => connection?.dispose()));
    try { await lease; }
    catch (error) { if (!["AbortError", "CleanupError"].includes(error.name)) throw error; }
    finally { lease = undefined; }
    if (connectionState.status !== "cleanup-unconfirmed") connectionState = { status: "disconnected", name: "" };
    return { ...connectionState, ...(released?.diagnostics ? { diagnostics: released.diagnostics } : {}) };
  }
  async function disconnect() {
    connectionControl?.abort();
    await connecting?.catch(() => {});
    return release();
  }
  return {
    dataDir,
    connectionState() { return { ...connectionState }; },
    disconnect,
    async connect(options = {}) {
      if (connecting) return connecting;
      if (connectionState.status === "connected") return this.connectionState();
      connectionControl = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, connectionControl.signal, ...(options.signal ? [options.signal] : [])]);
      connecting = (async () => {
        await release();
        if (signal.aborted) throw cancelled();
        let accept, reject;
        const result = new Promise((yes, no) => { accept = yes; reject = no; });
        connectionState = { status: "connecting", name: "" };
        const submitted = performance.now();
        lease = queueDevice(async () => {
          const queueMs = Math.max(0, Math.round(performance.now() - submitted));
          let reportedCleanup = false;
          const worker = connection = openConnection({ python, cwd: repoRoot, timeoutMs, terminate: terminateTree,
            args: ["-B", fileURLToPath(new URL("./recorder_worker.py", import.meta.url)), "--repo-root", repoRoot, "--data-dir", dataDir,
              "--timeout", String(operationSeconds)],
            onState: state => {
              if (state.status === "cleanup-unconfirmed") {
                connectionState = state;
                if (!reportedCleanup) {
                  reportedCleanup = true;
                  cleanupNotice = { epoch: ++cleanupEpoch, message: state.message || "Device connection release is unconfirmed" };
                }
              } else if (!reportedCleanup) connectionState = state;
            } });
          try {
            const state = await capture(worker.request("connect", { address: config.deviceAddress || "" }, { signal }).then(value => {
              if (value.diagnostics) value.diagnostics.queueMs = (value.diagnostics.queueMs || 0) + queueMs;
              return value;
            }));
            if (!reportedCleanup) connectionState = state;
            if (state.status === "connected" && !reportedCleanup) cleanupNotice = undefined;
            accept(state);
            if (state.status !== "connected") await worker.dispose();
            await worker.closed;
          } catch (error) { reject(error); await worker.dispose(); }
          finally { if (connection === worker) connection = undefined; }
        }, signal);
        lease.catch(error => {
          if (connectionState.status !== "cleanup-unconfirmed") connectionState = {
            status: error.name === "CleanupError" ? "cleanup-unconfirmed" : "disconnected", name: "", message: error.message };
          reject(error);
        });
        return result;
      })();
      try { return await connecting; } finally { connecting = undefined; }
    },
    async scan(options) {
      // Scanning while a persistent owner holds the global slot would deadlock.
      // An explicit scan releases that connection first, then discovers afresh.
      if (connection || connecting || lease) await disconnect();
      return bringup(["--scan"], options);
    },
    async status(options) { if (connecting) await connecting; return connection ? connectedCall("status", {}, options) : bringup(deviceArgs("--status"), options); },
    async list(options) { if (connecting) await connecting; return connection ? connectedCall("list", {}, options) : bringup(deviceArgs("--list"), options); },
    async recordState(options) { if (connecting) await connecting; return connection ? connectedCall("recordState", {}, options) : bringup(deviceArgs("--record-state"), options); },
    async record(action, options) {
      if (connecting) await connecting;
      if (!["start", "pause", "resume", "save"].includes(action)) throw new TypeError("Unsupported recording action");
      if (connection) return connectedCall("record", { action }, options);
      return bringup(deviceArgs("--record", action), options);
    },
    importFirst(outDir, transcribeFlag = false, options) {
      return this.importFile(undefined, outDir, transcribeFlag, options);
    },
    async importFile(filename, outDir = config.outDir ?? "archive/audio", transcribeFlag = false, options) {
      if (filename !== undefined && (typeof filename !== "string" || !filename || filename !== filename.trim() || /[\x00-\x1f/\\,]/.test(filename))) {
        throw new TypeError("filename must be one exact name from recorder_list, without paths or commas");
      }
      if (typeof transcribeFlag !== "boolean") throw new TypeError("transcribeFlag must be boolean");
      if (lifetime.signal.aborted || options?.signal?.aborted) {
        const error = Object.assign(cancelled(), { diagnostics: { version: 1, operation: "import", phase: "queued", outcome: "cancelled",
          elapsedMs: 0, queueMs: 0, bytesReceived: 0, dataFrames: 0, attempts: 0, cleanup: "not-needed" } });
        await observe(error);
        throw error;
      }
      if (options?.preflight !== undefined) {
        const { expectedBytes, bytesPerSecond } = parsePreflight(options.preflight);
        // Opt-in estimate only. List size is compressed storage, and the list's
        // time field is not a verified duration. Never infer either input here.
        const transferSeconds = expectedBytes / bytesPerSecond;
        const requiredSeconds = Math.ceil(transferSeconds * 1.25 + 15);
        if (requiredSeconds > operationSeconds) {
          const suggestedMs = requiredSeconds * 1000 + 10000;
          const advice = suggestedMs <= 2_147_483_647
            ? `Suggested cliTimeoutMs: ${suggestedMs} (including the Host cleanup reserve).`
            : "This estimate exceeds the maximum configurable Host timeout; select a smaller recording or remeasure the link.";
          const error = failure("ImportBudgetError", `Import not started: estimated ${expectedBytes} B at ${bytesPerSecond} B/s needs about ${Math.ceil(transferSeconds)} s for transfer, or ${requiredSeconds} s with 25% margin and 15 s setup allowance; Python operation budget is ${operationSeconds} s (Host cliTimeoutMs ${timeoutMs}). ${advice} These are caller-supplied estimates, not a device limit or completion guarantee. Confirm the estimate before changing configuration; do not silently retry without preflight.`, {
            diagnostics: { version: 1, operation: "import", phase: "queued", outcome: "failed", elapsedMs: 0,
              queueMs: 0, bytesReceived: 0, dataFrames: 0, attempts: 0, cleanup: "not-needed" },
          });
          await observe(error);
          throw error;
        }
      }
      if (connecting) await connecting;
      const destination = outsideSource(resolve(dataDir, text(outDir, "outDir")));
      if (connection && !transcribeFlag) return importOutcome(await connectedCall(filename === undefined ? "importFirst" : "importFile",
        { outDir: destination, ...(filename === undefined ? {} : { filename }) }, options), destination, false);
      if (connection) await disconnect();
      const args = deviceArgs(...(filename === undefined ? ["--import-first"] : [`--filename=${filename}`]), "--out", destination);
      if (transcribeFlag) args.push("--transcribe");
      const reportDir = await mkdtemp(join(tmpdir(), "recorder-result-"));
      const reportPath = join(reportDir, "result.json");
      let report, queueMs, submitted = performance.now();
      try {
        return await bringup(args, { ...options, onDispatch: value => { queueMs = value; } }, ["--result-file", reportPath], async (_result, processError) => {
          // Only explicit process-runner evidence proves that BLE could not
          // have been touched. Dispatch or an error name alone cannot prove it.
          if (processError?.processStarted === false) throw processError;
          let outcome;
          let cleanup;
          const checkCleanup = value => {
            cleanup = cleanupOutcome(value);
            if (cleanup.status === "unconfirmed") {
              const message = cleanup.errors.map(item => item.message).join("; ");
              cleanupNotice = { epoch: ++cleanupEpoch, message };
              connectionState = { status: "cleanup-unconfirmed", name: "", message };
            }
          };
          const cleanupFailure = cause => failure("CleanupError", `${cause.message}; ${cleanup.errors.map(item => item.message).join("; ")}`, {
            cause, operationError: cause, closed: cause.closed, processStarted: cause.processStarted,
            cleanup, diagnostics: cause.diagnostics || (report?.version === 2 ? report.diagnostics : undefined),
          });
          try {
            report = JSON.parse(await readFile(reportPath, "utf8"));
            if (report?.version !== 2) throw failure("ImportResultError", "Import result version is missing or unsupported; device release cannot be confirmed");
            checkCleanup(report.cleanup);
            if (report.diagnostics) {
              const info = await stat(reportPath);
              report.diagnostics = parseDiagnostics({ ...report.diagnostics, queueMs: queueMs ?? 0,
                snapshotAgeMs: Math.max(0, Math.round(Date.now() - info.mtimeMs)) });
              if (processError) {
                if (report.diagnostics.outcome === "running") {
                  report.diagnostics = { ...report.diagnostics, failedPhase: report.diagnostics.phase,
                    outcome: processError.name === "AbortError" ? "cancelled" : "failed", cleanup: "unconfirmed" };
                }
                processError.diagnostics = report.diagnostics;
              }
            }
            outcome = importOutcome(report, destination, transcribeFlag);
          }
          catch (error) {
            // Missing, unreadable, malformed or unsupported reports cannot
            // confirm device release, even after the process has exited.
            if (!cleanup) checkCleanup(undefined);
            if (cleanup?.status === "unconfirmed") {
              const cause = processError || error;
              if (error.audioPath) cause.message += `; imported audio retained at ${error.audioPath}`;
              throw cleanupFailure(cause);
            }
            if (processError) {
              const name = { DEVICE_DISCONNECTED: "DeviceDisconnectedError", TRANSFER_INTERRUPTED: "TransferInterruptedError" }[report?.error?.code];
              if (processError.name === "CliExitError" && name && typeof report.error.message === "string") {
                throw failure(name, report.error.message, { cause: processError, diagnostics: processError.diagnostics });
              }
              if (error.audioPath) processError.message += `; imported audio retained at ${error.audioPath}`;
              throw processError;
            }
            if (error.name === "ImportResultError") throw error;
            throw failure("ImportResultError", "Import result is missing or invalid; inspect the output directory before retrying", { cause: error });
          }
          if (processError && !(processError.name === "CliExitError" && outcome.status === "partial")) {
            processError.message += `; imported audio retained at ${outcome.import.path}`;
            if (outcome.cleanup.status === "unconfirmed") throw cleanupFailure(processError);
            throw processError;
          }
          return await observe(outcome);
        });
      } catch (error) {
        if (!error.diagnostics && report?.version === 2 && report.diagnostics) error.diagnostics = report.diagnostics;
        if (error.diagnostics && error.cleanup?.status === "unconfirmed") error.diagnostics = { ...error.diagnostics, cleanup: "unconfirmed" };
        error.diagnostics ??= { version: 1, operation: "import", phase: queueMs === undefined ? "queued" : "starting",
          outcome: error.name === "AbortError" || error.operationError?.name === "AbortError" ? "cancelled" : "failed", elapsedMs: queueMs === undefined ? 0 : Math.max(0, Math.round(performance.now() - submitted) - queueMs),
          queueMs: queueMs ?? Math.max(0, Math.round(performance.now() - submitted)), bytesReceived: 0, dataFrames: 0, attempts: 0,
          cleanup: queueMs === undefined || error.processStarted === false ? "not-needed" : "unconfirmed" };
        await observe(error);
        throw error;
      } finally {
        await rm(reportDir, { recursive: true, force: true });
      }
    },
    async transcribe(file, { force = false, signal, provider, outDir } = {}) {
      if (typeof force !== "boolean") throw new TypeError("force must be boolean");
      const audio = resolve(dataDir, text(file, "file"));
      const args = [];
      if (provider !== undefined) {
        if (provider !== "doubao") throw new TypeError("Unsupported CLI transcription provider");
        args.push("--provider", provider);
      }
      if (outDir !== undefined) args.push("--out-dir", outsideSource(resolve(dataDir, text(outDir, "outDir"))));
      if (force) args.push("--force");
      return run(adapter, ["--repo-root", repoRoot, "--data-dir", dataDir, "--transcribe-file", audio, "--", ...args], { signal }, false);
    },
    async dispose() {
      lifetime.abort();
      await disconnect();
      await Promise.allSettled([...pending]);
      if (unfinished.size) throw failure("CleanupError", "Recorder CLI has not exited; device queue remains blocked");
    },
  };
}
