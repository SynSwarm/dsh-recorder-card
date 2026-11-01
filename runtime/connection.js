import { spawn } from "node:child_process";

const error = (name, message) => Object.assign(new Error(message), { name });

// One worker owns one BLE session. An active request's timeout/cancellation kills
// that session; cancelling an unsent request leaves it alone. Retain the BLE
// slot until closed, including process-tree termination.
export function createConnection({ python, args, cwd, timeoutMs, terminate, onState, spawnProcess = spawn }) {
  const child = spawnProcess(python, args, { cwd, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  let sequence = 0, buffer = "", diagnostic = "", ended = false, stopping, expectingExit = false;
  let retirementTimer;
  let terminalWarning;
  const warnCleanup = message => {
    terminalWarning ??= { status: "cleanup-unconfirmed", name: "", message };
    onState(terminalWarning);
  };
  let finishClose;
  const closed = new Promise(resolve => { finishClose = resolve; });
  const pending = new Map();
  let tail = Promise.resolve();
  const rejectAll = reason => { for (const item of pending.values()) item.reject(reason); pending.clear(); };
  const stop = reason => {
    if (stopping) return stopping;
    warnCleanup("连接已停止；连接释放未确认，请检查设备后重连。");
    rejectAll(reason);
    stopping = (async () => {
      if (!ended && child.pid) await terminate(child);
    })().catch(cause => {
      throw Object.assign(error("CleanupError", "Could not terminate recorder worker; device queue remains occupied"), { cause, closed });
    });
    stopping.catch(() => {});
    return stopping;
  };
  child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { void stop(error("OutputLimitError", "Recorder worker output exceeded limit")); return; }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.event) {
          if (message.event.status === "cleanup-unconfirmed") warnCleanup(message.event.message || "Connection release is unconfirmed");
          else if (!terminalWarning) onState(message.event);
          if (["disconnected", "cleanup-unconfirmed"].includes(message.event.status) && !expectingExit && !stopping) {
            expectingExit = true;
            // Unblock Python's stdin reader so asyncio.run can join its executor.
            // The worker cancels active BLE work and runs disconnect in finally.
            child.stdin.end();
            retirementTimer = setTimeout(() => {
              void stop(error("CleanupError", "Disconnected worker did not exit; connection release unconfirmed"));
            }, 10_000); // Python disconnect has a five-second bound.
          }
        }
        else {
          const item = pending.get(message.id);
          if (!item) continue;
          pending.delete(message.id);
          if (message.error || item.method === "disconnect" ||
              (item.method === "connect" && message.result?.status !== "connected")) expectingExit = true;
          if (message.cleanupError) warnCleanup(`Connection release is unconfirmed: ${message.cleanupError}`);
          if (message.error) item.reject(error(message.cleanupError ? "CleanupError" : "CliExitError",
            `${message.error}${message.cleanupError ? `; connection release unconfirmed: ${message.cleanupError}` : ""}`));
          else item.resolve(message.result);
        }
      } catch { void stop(error("CliExitError", "Invalid recorder worker response")); }
    }
  });
  child.stdin.on("error", cause => { void stop(error("CliExitError", `Recorder worker input closed: ${cause.message}`)); });
  child.on("error", cause => rejectAll(error("CliSpawnError", `Could not start recorder worker: ${cause.message}. Install Python 3.11+ and bleak requests.`)));
  child.on("close", async (code, exitSignal) => {
    ended = true;
    clearTimeout(retirementTimer);
    await stopping?.catch(() => {});
    if (code !== 0) warnCleanup(`Recorder worker exited unexpectedly (${code ?? exitSignal}); connection release is unconfirmed${diagnostic ? `: ${diagnostic}` : ""}`);
    rejectAll(error("CliExitError", `Recorder worker exited (${code ?? exitSignal})${diagnostic ? `: ${diagnostic}` : ""}`));
    const terminal = terminalWarning ?? { status: "disconnected", name: "" };
    onState(terminal);
    finishClose(terminal);
  });
  function request(method, args = {}, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(error("AbortError", "Recorder operation cancelled"));
    let started = false, abortQueued;
    const invoke = async () => {
      started = true;
      signal?.removeEventListener("abort", abortQueued);
      if (signal?.aborted) throw error("AbortError", "Recorder operation cancelled");
      if (ended || stopping || expectingExit) throw error("CliExitError", "Recorder connection closed; connect again");
      const id = ++sequence;
      let timer;
      const aborted = () => { void stop(error("AbortError", "Recorder operation cancelled; device outcome may be unknown")); };
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, method });
          signal?.addEventListener("abort", aborted, { once: true });
          timer = setTimeout(() => { void stop(error("TimeoutError", "Recorder operation timed out; device outcome may be unknown")); }, timeoutMs);
          child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
          if (signal?.aborted) aborted();
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      }
    };
    const result = tail.then(invoke);
    tail = result.catch(() => {});
    // Reject the caller immediately, but keep the internal chain behind the
    // active operation. invoke() will skip the cancelled item without writing.
    return new Promise((resolve, reject) => {
      abortQueued = () => {
        if (started) return;
        signal.removeEventListener("abort", abortQueued);
        reject(error("AbortError", "Queued recorder operation cancelled; nothing sent to device"));
      };
      signal?.addEventListener("abort", abortQueued, { once: true });
      if (signal?.aborted) abortQueued();
      result.then(resolve, reject);
    });
  }
  return { closed, request,
    async dispose() {
      let primary;
      if (!ended && !stopping && !expectingExit) {
        try { await request("disconnect"); }
        catch (cause) { primary = cause; await stop(cause); }
      }
      await stopping;
      await closed;
      if (primary) throw primary;
    },
  };
}
