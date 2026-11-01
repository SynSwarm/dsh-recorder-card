# Installed runtime and external CLI prerequisites

This file is shipped with the recorder Skill. Developer architecture and contribution documents are maintained in the source repository and are not required to read this installed Skill.

## Primary workflow

The selected main path is DSH Host → external Python CLI → recorder card. The browser Web Bluetooth card is optional and is not a prerequisite for Host loading or CLI experiments. The current workspace build registers six CLI-backed tools; full hardware and transcription acceptance is separate.

Validate the standalone CLI first on the intended Host machine: pin its upstream commit and record Python/Bleak, OS, Bluetooth adapter/driver, permissions, and the actual script arguments. Verify scan/status/list and import/play one disposable recording, then recording controls and failure recovery. Keep standalone CLI results separate from later DSH tool acceptance.

## Execution locations

The browser card uses Bluetooth on the browser's machine. The Host runs Python on the DSH Host machine, which can be different. A remote Host does not automatically have access to the browser's Bluetooth hardware.

The Host machine must have working Bluetooth hardware and permissions and be able to connect to the intended card. Use one BLE owner at a time. Disconnect any browser session and stop other CLI sessions before a CLI experiment; stop the Python session before reconnecting the browser. Do not combine file import and realtime capture.

The current wrapper starts a subprocess per call. The [Host process manager](../../runtime/host-cli.js) shares one device queue across service instances in the same loaded module, including scans and imports. Standalone transcription runs outside the BLE queue but is also cancelled on disposal. Other Node Hosts, separate module copies, manual CLI sessions and browser connections are not coordinated. A future UI may read Host state and send Host commands; the existing browser card instead connects directly and cannot serve as a simultaneous monitor while Python owns the card.

The manager accepts cancellation signals, rejects cancelled queued calls without spawning, and waits for active subprocess exit before releasing the device queue. Its cleanup is registered with `ctx.effect`. Windows local tests and real DSH isolated-profile disable/re-enable passed, including termination of an active synthetic subprocess. BLE cancellation remains unverified.

## Bundled CLI adapter

The [adapter](../../runtime/recorder_cli.py) loads an external checkout corresponding to upstream commit `de42d1fbf19fc92064ac4688f71f42730c82267f`. It verifies SHA-256 of `tools/qs668-bringup.py` and `tools/qs668_protocol.py` (normalizing CRLF to LF) before import. Unsupported/missing source fails before any BLE operation. It does not download, patch, or install the external CLI. This path has been tested with Python 3.12.7 and Bleak 3.0.2 on Windows.

From the installed plugin directory, replace the placeholders locally:

```text
python runtime/recorder_cli.py --repo-root <absolute-upstream-checkout> -- --help
python runtime/recorder_cli.py --repo-root <absolute-upstream-checkout> -- --scan
python runtime/recorder_cli.py --repo-root <absolute-upstream-checkout> -- --address <device> --list
```

The adapter requires `2-18` status `0` for a complete list and rejects malformed list entry counts. No-response/partial-list timeouts and invalid end states fail; they block another list/record command on that session. Recording start/save/pause/resume require the corresponding `3-2/4/6/8` response with status `1`; hardware events or a state response are not substitutes. An unconfirmed command may already have executed: inspect state, reconnect, and make an explicit recovery decision instead of blindly retrying.

Device operations have a default 180-second asynchronous operation timeout, adjustable with adapter `--timeout` before the `--` separator. List response limits are 4 seconds initially, 1.2 seconds of idle time after data, and 30 seconds overall; recording acknowledgement waits up to 3 seconds. Cleanup attempts are limited to 5 seconds per session and cleanup failure is reported. These are adapter policies, not firmware guarantees. Exit codes include 1 for validation/unconfirmed results, 124 for operation timeout, and 130 for keyboard cancellation; scan exit 0 can still mean no device. Blocking external subprocess work such as transcription is outside the asynchronous BLE timeout guarantee.

The internal Host device methods use this adapter. Direct external transcription remains separate. The adapter stages imports privately and publishes without overwriting existing audio. RIFF/WAVE PCM structure and frame completeness are checked before publication; other formats remain unconfirmed and fail. Source-content integrity and every device status field still require independent evidence. Source pinning and confirmation checks do not establish full M2a/M2b acceptance.

## Current Host wrapper

These fields are read by the current JavaScript wrapper. They are declared by the plugin Config schema, verified during isolated DSH Host loading. Desktop settings UI remains unverified.

| Field | Default | Meaning |
|---|---|---|
| `python` | `python` | Interpreter available on the Host |
| `repoRoot` | Host `process.cwd()` | External checkout containing `tools/qs668-bringup.py` and `tools/qs668-transcribe.py`; also the subprocess working directory |
| `deviceAddress` | None | Required non-empty value for device operations other than scanning; rejected before spawning when missing |
| `outDir` | `archive/audio` | First-file import destination; converted to an absolute path under `repoRoot` |
| `cliTimeoutMs` | `190000` | Positive integer Host execution timeout in milliseconds, excluding queue time; does not change the adapter's own 180-second asynchronous limit |

Internal method signatures are `scan/status/list/recordState({ signal }?)`, `record(action, { signal }?)`, `importFirst(outDir?, transcribeFlag?, { signal }?)`, and `transcribe(file, { force?, signal? }?)`. Recording actions are restricted to `start`, `pause`, `resume`, and `save`. These are internal service signatures; the six Agent tools are defined in the [tool adapter](../../runtime/tools.js). Except for import, successful processes return `{ code, out, err }`; import uses the separate stage result described below. Failures distinguish `CliSpawnError`, `CliExitError`, `AbortError`, `TimeoutError`, `OutputLimitError`, and `CleanupError`. Exit failures retain output/exit details; zero exit alone does not prove every status field or imported file is valid.

The Host caps captured stdout/stderr at 8 MiB total. Cancellation, timeout and output overflow terminate the process tree using Windows `taskkill /T /F`, or a POSIX process group (SIGTERM followed by SIGKILL after one second). The POSIX path is not validated. If termination fails while the process remains open, the call reports `CleanupError`, disposal reports incomplete cleanup, and the device queue stays blocked until actual exit. Normal Python completion attempts BLE disconnect; forced termination cannot guarantee Python finally blocks or firmware state. Inspect device state and any partial file before recovery; cancellation is not a recording stop/save command, and commands are never automatically retried.

This package includes the small Python adapter and JavaScript process manager, not the external CLI, its dependencies, or upstream protocol documentation. Locate an external checkout and verify its revision, scripts, dependency instructions, and supported arguments before use. The wrapper does not install dependencies or initialize credentials.

The wrapper does not read `.env` itself. Subprocesses inherit the Host environment with Python UTF-8 I/O enabled. Transcription currently invokes an external script with an audio path and optional `--force`; backend support depends on that script. The project has selected DSH speech-to-text as its default integration target, but the DSH backend and provider-selection setting are not implemented yet.

## Safe import and separate transcription results

The adapter runs the pinned upstream import in a fresh `.recorder-import-*` directory beneath the destination. After the upstream function confirms transfer completion, it validates RIFF/WAVE PCM structure, computes SHA-256, flushes the file, and publishes it using an atomic hard link. RIFF length must equal file length, every chunk including padding must fit, PCM format fields must agree, and sample data must contain whole non-empty frames. Missing/duplicate format or data chunks, truncated/unsupported encodings fail as integrity unconfirmed before publication or transcription. Existing names (including a file created concurrently) are never replaced; a UUID suffix is chosen on conflict. The filesystem must support hard links; failure does not fall back to an overwriting copy/rename. Normal failure/cancellation removes staging; forced process termination may leave an ignored-looking staging directory, which is not a completed import. Already published audio remains intact. Verification is limited to the supported PCM container and sample frames, not a source checksum or proof of absence of all transmission corruption; M3 hardware acceptance remains pending.

`recorder_import` now returns `{ status, import, transcription, cleanup }`. `import` contains `status: succeeded`, the actual absolute `path`, `bytes`, `sha256`, and `integrity` (verified PCM format, channels, sample rate, bit depth and frame count). Transcription is `not-requested`, `succeeded`, or `failed`. On transcription failure, overall `status` is `partial`, with an independent `transcription.error` and `transcription.retry` naming `recorder_transcribe` with the retained audio path. Retry transcription only, not import. DSH dispatch may have `isError: false` for this successfully reported partial workflow: callers must inspect the explicit workflow and stage statuses. Import/validation failures remain DSH errors, and cancellation must not be reported as workflow success.

Cleanup is independently `succeeded`, `not-needed`, or `unconfirmed`, with structured errors. Every disconnect attempt is observed, including the first call inside upstream code. A failed, timed-out or cancelled attempt remains unconfirmed even if upstream clears its client reference and a later call returns without doing anything. A pending/missing cleanup result is unconfirmed. Either transcription failure or unconfirmed cleanup makes the workflow `partial`; both problems survive when they occur together. Do not assume the device was released or start another BLE operation while cleanup is unconfirmed.

The Host reads a private version-2 JSON report written atomically by the adapter through `--result-file`; it does not infer stage success from log text. Missing or invalid reports fail. Adapter-driven post-import transcription has a 120-second subprocess limit, raises on failure, and does not run the upstream credential-init helper. It uses the external script's existing configuration, not the planned DSH backend. Direct CLI transcription failure exits nonzero and preserves imported audio. Full transcription provenance and transcript integrity remain M4 work.

## Output and completion

Prefer explicit absolute input/output paths during verification. `archive/audio/` and `archive/corpus/` are intended locations, not a proven plugin-wide storage contract. Report the actual output path. A standalone CLI success does not prove DSH Agent tools or browser import are working.

Preserve imported audio when transcription fails. Do not reuse a transcript solely because a filename matches; require valid text and a matching `audio_sha256` when the chosen implementation supports reuse. Keep audio, transcripts, credentials, and device-address caches out of version control at the actual output location.

## Browser list recovery

After list timeout, write failure, or unconfirmed completion, the browser blocks same-session list retries. Disconnect and reconnect before reading again. Old-session notifications must not be used to confirm a new list. Device behavior across reconnections and timeout thresholds still require hardware validation.
