import { spawn, execFile } from "node:child_process";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "./connection.js";

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
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
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
            cause, operationError: reason, closed,
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
      if (problem) reject(Object.assign(problem, { code, exitSignal, out, err }));
      else if (code !== 0) reject(failure("CliExitError", `Recorder CLI exited ${code ?? exitSignal}`, { code, exitSignal, out, err }));
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
  const cleanup = report.cleanup;
  const confirmedCleanup = cleanup && ["succeeded", "not-needed", "retained"].includes(cleanup.status) && Array.isArray(cleanup.errors) && cleanup.errors.length === 0;
  const cleanupResult = confirmedCleanup ? cleanup : {
    status: "unconfirmed",
    errors: [{ code: "DEVICE_CLEANUP_UNCONFIRMED", message: "Device connection release is unconfirmed; inspect the device before another BLE operation" },
      ...(Array.isArray(cleanup?.errors) ? cleanup.errors.filter(error => typeof error?.code === "string" && typeof error?.message === "string") : [])],
  };
  return { status: transcription.status === "failed" || !confirmedCleanup ? "partial" : "succeeded", import: audio, transcription, cleanup: cleanupResult };
}

export function createRecorderService(config = {}, { execute = runProcess, openConnection = createConnection } = {}) {
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
  const adapter = fileURLToPath(new URL("./recorder_cli.py", import.meta.url));
  const lifetime = new AbortController();
  const pending = new Set();
  const unfinished = new Set();
  let connection, connecting, lease, connectionControl;
  let connectionState = { status: "disconnected", name: "" };
  let notifiedCleanupEpoch = 0;
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
  function run(script, args, options = {}, device = true) {
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    if (signal.aborted) return Promise.reject(cancelled());
    const invoke = () => execute(python, ["-B", script, ...args], { cwd: repoRoot, signal, timeoutMs });
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
  const bringup = (args, options, adapterArgs = []) => run(adapter, ["--repo-root", repoRoot, "--data-dir", dataDir, ...adapterArgs, "--", ...args], options);
  const connectedCall = (method, args, options = {}) => connection.request(method, args,
    { signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal });
  async function release() {
    await connection?.dispose();
    try { await lease; }
    catch (error) { if (!["AbortError", "CleanupError"].includes(error.name)) throw error; }
    finally { lease = undefined; }
    if (connectionState.status !== "cleanup-unconfirmed") connectionState = { status: "disconnected", name: "" };
    return connectionState;
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
        lease = queueDevice(async () => {
          let reportedCleanup = false;
          const worker = connection = openConnection({ python, cwd: repoRoot, timeoutMs, terminate: terminateTree,
            args: ["-B", fileURLToPath(new URL("./recorder_worker.py", import.meta.url)), "--repo-root", repoRoot, "--data-dir", dataDir],
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
            const state = await worker.request("connect", { address: config.deviceAddress || "" }, { signal });
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
    async importFirst(outDir = config.outDir ?? "archive/audio", transcribeFlag = false, options) {
      if (connecting) await connecting;
      if (typeof transcribeFlag !== "boolean") throw new TypeError("transcribeFlag must be boolean");
      const destination = outsideSource(resolve(dataDir, text(outDir, "outDir")));
      if (connection && !transcribeFlag) return importOutcome(await connectedCall("importFirst", { outDir: destination }, options), destination, false);
      if (connection) await disconnect();
      const args = deviceArgs("--import-first", "--out", destination);
      if (transcribeFlag) args.push("--transcribe");
      const reportDir = await mkdtemp(join(tmpdir(), "recorder-result-"));
      const reportPath = join(reportDir, "result.json");
      try {
        let processError;
        try { await bringup(args, options, ["--result-file", reportPath]); }
        catch (error) { processError = error; }
        let outcome;
        try { outcome = importOutcome(JSON.parse(await readFile(reportPath, "utf8")), destination, transcribeFlag); }
        catch (error) {
          if (processError) {
            if (error.audioPath) processError.message += `; imported audio retained at ${error.audioPath}`;
            throw processError;
          }
          if (error.name === "ImportResultError") throw error;
          throw failure("ImportResultError", "Import result is missing or invalid; inspect the output directory before retrying", { cause: error });
        }
        if (processError && !(processError.name === "CliExitError" && outcome.status === "partial")) {
          processError.message += `; imported audio retained at ${outcome.import.path}`;
          if (outcome.cleanup.status === "unconfirmed") processError.message += "; device connection release is unconfirmed";
          throw processError;
        }
        return outcome;
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
