# Installed runtime and Python prerequisites

This file is shipped with the recorder Skill. Developer architecture and contribution documents are maintained in the source repository and are not required to read this installed Skill.

## Primary workflow

The selected main path is DSH Host → bundled Python CLI → recorder card. The optional Client card calls the same Host service through Typert Remote and owns no BLE connection; it is not a prerequisite for Host loading or CLI experiments. The current workspace build registers six CLI-backed tools; full hardware and transcription acceptance is separate.

Validate the standalone CLI first on the intended Host machine: use the bundled pinned sources and record Python/Bleak, OS, Bluetooth adapter/driver, permissions, and the actual script arguments. Verify scan/status/list and import/play one disposable recording, then recording controls and failure recovery. Keep standalone CLI results separate from later DSH tool acceptance.

## Execution locations

The Client card calls Host Remote. The Host runs Python and Bluetooth on the DSH Host machine, which may differ from the browser machine. A remote Host does not automatically have access to the browser's Bluetooth hardware.

The Host machine must have working Bluetooth hardware and permissions and be able to connect to the intended card. Use one BLE owner at a time. Disconnect external browser direct-BLE sessions, phone apps and other CLI sessions before device access; the current card itself owns no BLE connection. Do not combine file import and realtime capture.

The current wrapper starts a subprocess per call. The [Host process manager](../../runtime/host-cli.js) shares one device queue across service instances in the same loaded module, including scans and imports. Standalone transcription runs outside the BLE queue but is also cancelled on disposal. Other Node Hosts, separate module copies, manual CLI sessions and browser connections are not coordinated. The current UI sends Host commands through the same injectable recorder Service. Status is a new BLE operation, not a live progress monitor; do not poll it while scanning/importing.

The manager accepts cancellation signals, rejects cancelled queued calls without spawning, and waits for active subprocess exit before releasing the device queue. Its cleanup is registered with `ctx.effect`. Windows local tests and real DSH isolated-profile disable/re-enable passed, including termination of an active synthetic subprocess. BLE cancellation remains unverified.

## Bundled CLI adapter

The [adapter](../../runtime/recorder_cli.py) loads bundled `vendor/upstream/` sources from upstream commit `de42d1fbf19fc92064ac4688f71f42730c82267f`. It verifies SHA-256 of `tools/qs668-bringup.py` and `tools/qs668_protocol.py` (normalizing CRLF to LF) before import. Unsupported/missing source fails before any BLE operation. The scripts, requirements, full MIT license and provenance are shipped in the package. No clone is needed. `repoRoot` is an optional developer override; missing or empty uses bundled sources. The device-source hashes are unchanged, and transcription has its own pinned hash. It does not download or modify upstream scripts. This path has been tested with Python 3.12.7 and Bleak 3.0.2 on Windows.

Install Python 3.11+ on the Host and run `python -m pip install bleak requests` with the same interpreter configured in `python`. Missing/broken dependencies report that interpreter and installation command; no dependencies are installed automatically. From the installed plugin directory:

```text
python -B runtime/recorder_cli.py --check-deps
python -B runtime/recorder_cli.py -- --help
python -B runtime/recorder_cli.py -- --scan
python -B runtime/recorder_cli.py -- --address <device> --list
```

The adapter requires `2-18` status `0` for a complete list and rejects malformed list entry counts. No-response/partial-list timeouts and invalid end states fail; they block another list/record command on that session. Recording start/save/pause/resume require the corresponding `3-2/4/6/8` response with status `1`; hardware events or a state response are not substitutes. An unconfirmed command may already have executed: inspect state, reconnect, and make an explicit recovery decision instead of blindly retrying.

Device operations have a default 180-second asynchronous operation timeout, adjustable with adapter `--timeout` before the `--` separator. List response limits are 4 seconds initially, 1.2 seconds of idle time after data, and 30 seconds overall; recording acknowledgement waits up to 3 seconds. Cleanup attempts are limited to 5 seconds per session and cleanup failure is reported. These are adapter policies, not firmware guarantees. Exit codes include 1 for validation/unconfirmed results, 124 for operation timeout, and 130 for keyboard cancellation; scan exit 0 can still mean no device. Blocking external subprocess work such as transcription is outside the asynchronous BLE timeout guarantee.

The internal Host device methods use this adapter. Standalone transcription uses the same adapter without opening a BLE session. The adapter stages imports privately and publishes without overwriting existing audio. RIFF/WAVE PCM structure and frame completeness are checked before publication; other formats remain unconfirmed and fail. Source-content integrity and every device status field still require independent evidence. Source pinning and confirmation checks do not establish full M2a/M2b acceptance.

## Current Host wrapper

These fields are read by the current JavaScript wrapper. They are declared by the plugin Config schema, verified during isolated DSH Host loading. Desktop settings UI remains unverified.

| Field | Default | Meaning |
|---|---|---|
| `python` | `python` | Interpreter available on the Host |
| `repoRoot` | Package `vendor/upstream/` | Optional developer source override at the same pinned revision; omitted/empty uses bundled sources. Not a data directory |
| `dataDir` | Host user home `~/.dsh-recorder-card` | Writable data root for audio, corpus, device cache and optional ASR `.env`; independent of source location |
| `deviceAddress` | None | Required non-empty value for device operations other than scanning; rejected before spawning when missing |
| `outDir` | `archive/audio` | First-file import destination; converted to an absolute path under `dataDir` |
| `cliTimeoutMs` | `190000` | Positive integer Host execution timeout in milliseconds, excluding queue time; does not change the adapter's own 180-second asynchronous limit |

Internal method signatures are `scan/status/list/recordState({ signal }?)`, `record(action, { signal }?)`, `importFirst(outDir?, transcribeFlag?, { signal }?)`, and `transcribe(file, { force?, signal? }?)`. Recording actions are restricted to `start`, `pause`, `resume`, and `save`. These are internal service signatures; the six Agent tools are defined in the [tool adapter](../../runtime/tools.js). Except for import and transcription, successful processes return `{ code, out, err }`; import uses the separate stage result described below. Failures distinguish `CliSpawnError`, `CliExitError`, `AbortError`, `TimeoutError`, `OutputLimitError`, and `CleanupError`. Exit failures retain output/exit details; zero exit alone does not prove every status field or imported file is valid.

The Host caps captured stdout/stderr at 8 MiB total. Cancellation, timeout and output overflow terminate the process tree using Windows `taskkill /T /F`, or a POSIX process group (SIGTERM followed by SIGKILL after one second). The POSIX path is not validated. If termination fails while the process remains open, the call reports `CleanupError`, disposal reports incomplete cleanup, and the device queue stays blocked until actual exit. Normal Python completion attempts BLE disconnect; forced termination cannot guarantee Python finally blocks or firmware state. Inspect device state and any partial file before recovery; cancellation is not a recording stop/save command, and commands are never automatically retried.

This package includes the adapter, JavaScript process manager and pinned Python CLI sources. Python/Bleak/requests and optional ffmpeg are system dependencies, not bundled binaries. Upstream protocol documentation is not included. No dependency installer or credential bootstrap runs automatically.

Subprocesses inherit the Host environment with Python UTF-8 I/O and bytecode writing disabled. `transcriptionProvider` defaults to `dsh`: the injectable recorder service resolves the Host's selected recognizer with `speechToText.resolve({ audio })`, then calls `transcribe(spec, signal)`. A local DSH recognizer requires prepared models, not cloud credentials. Only an absent service falls back to `doubao`; an existing service's resolution, readiness, inference or cancellation failure never triggers fallback. Explicit `doubao` uses the pinned CLI, Host environment variables and `dataDir/.env`, and uploads audio. Do not initiate transcription without user intent.

Standalone transcription returns `{ status: succeeded, provider, recognizer, path, audioPath, audioSha256, reused, fallbackReason? }`, not a process result. Its stable failure code is `RECORDER_TRANSCRIPTION_FAILED` (Remote: `recorder/transcription-failed`). Audio remains available after failure. Import releases BLE before invoking this same pipeline and preserves independent cleanup warnings. DSH's plain `Transcript` has no diarization or segment times: Markdown labels the default speaker and filename-derived start time explicitly, with an unknown timezone.

Archives under `dataDir/archive/corpus/` use content SHA-256 plus provider/recognizer/language/schema identity, verify body integrity before reuse, and atomically publish without replacing existing files. `force` creates a new result without deleting the old one. Empty recognition is an error. Current input is canonical 44-byte-header, 16 kHz mono PCM16 WAV up to 64 MiB; the selected recognizer may impose a lower limit. There is no automatic splitting/resampling. A recognizer model changed under the same ID requires `force` to regenerate an archive.

## Cache association fixes after 0.3.0

The workspace rechecks the current audio fingerprint immediately before returning a cache hit or publishing a new archive. Changed, truncated or removed files fail without a stale success. A same-content file at another path reuses recognition text but publishes a separate Markdown with the current `audio` path and title; `reused: true` does not require the Markdown path to stay the same. Existing exact-path archives take precedence. Original archives remain unchanged. `transcription_source_audio` and `recorded_at_source_audio` preserve historical recognition and filename-derived timing provenance; they may no longer exist and are not active audio references. Renaming does not shift transcript times. Validation applies at return/publication time, not to future external writes. These fixes are not shipped in npm 0.3.0.

## Safe import and separate transcription results

The adapter runs the pinned upstream import in a fresh `.recorder-import-*` directory beneath the destination. After the upstream function confirms transfer completion, it validates RIFF/WAVE PCM structure, computes SHA-256, flushes the file, and publishes it using an atomic hard link. RIFF length must equal file length, every chunk including padding must fit, PCM format fields must agree, and sample data must contain whole non-empty frames. Missing/duplicate format or data chunks, truncated/unsupported encodings fail as integrity unconfirmed before publication or transcription. Existing names (including a file created concurrently) are never replaced; a UUID suffix is chosen on conflict. The filesystem must support hard links; failure does not fall back to an overwriting copy/rename. Normal failure/cancellation removes staging; forced process termination may leave an ignored-looking staging directory, which is not a completed import. Already published audio remains intact. Verification is limited to the supported PCM container and sample frames, not a source checksum or proof of absence of all transmission corruption; M3 hardware acceptance remains pending.

`recorder_import` now returns `{ status, import, transcription, cleanup }`. `import` contains `status: succeeded`, the actual absolute `path`, `bytes`, `sha256`, and `integrity` (verified PCM format, channels, sample rate, bit depth and frame count). Transcription is `not-requested`, `succeeded`, or `failed`. On transcription failure, overall `status` is `partial`, with an independent `transcription.error` and `transcription.retry` naming `recorder_transcribe` with the retained audio path. Retry transcription only, not import. DSH dispatch may have `isError: false` for this successfully reported partial workflow: callers must inspect the explicit workflow and stage statuses. Import/validation failures remain DSH errors, and cancellation must not be reported as workflow success.

Cleanup is independently `succeeded`, `not-needed`, or `unconfirmed`, with structured errors. Every disconnect attempt is observed, including the first call inside upstream code. A failed, timed-out or cancelled attempt remains unconfirmed even if upstream clears its client reference and a later call returns without doing anything. A pending/missing cleanup result is unconfirmed. Either transcription failure or unconfirmed cleanup makes the workflow `partial`; both problems survive when they occur together. Do not assume the device was released or start another BLE operation while cleanup is unconfirmed.

The Host reads a private version-2 JSON import/cleanup report written atomically by the adapter through `--result-file`; missing or invalid reports fail. The shared recorder service imports with CLI transcription disabled, then runs the DSH/default-or-Doubao pipeline described above. The lower-level Python adapter retains its separately tested 120-second CLI post-import transcription option for direct callers; that option does not implement DSH STT. ASR credentials are not needed for scan/import. Direct CLI transcription failure exits nonzero and preserves imported audio. Complete hardware recovery remains unaccepted.

## Output and completion

Prefer explicit absolute input/output paths during verification. Audio defaults to `dataDir/archive/audio/`; transcription defaults to `dataDir/archive/corpus/`. Relative tool paths resolve under `dataDir`, never `repoRoot`. Python bytecode writing is disabled. Data paths inside CLI sources are rejected by the Host. Existing users: relative paths previously resolved under repoRoot. Old files are left untouched; use absolute audio paths or copy them to the new data directory. Do not set dataDir to the CLI source tree. No files are migrated automatically. Report the actual output path. A standalone CLI success does not prove DSH Agent tools or browser import are working.

Preserve imported audio when transcription fails. Do not reuse a transcript solely because a filename matches; require valid text and a matching `audio_sha256` when the chosen implementation supports reuse. Keep audio, transcripts, credentials, and device-address caches out of version control at the actual output location.

## Client Remote cancellation and retry

The Client uses six cancellable Remote methods and checks both the Remote `ok` branch and import stage statuses. Cancel/unmount aborts the corresponding Host call; process termination does not prove BLE release or stop/save a recording. Check device state before retrying an uncertain operation. Import/transcription partial results retain the saved audio; retry transcription on that path instead of re-importing. The old browser list retry rules apply only to the retired regression fixture.

## Device selection

The card provides Device settings → Device address → Save. `recorder-settings.json` under dataDir stores the selection atomically; it is shared by the card and Agent tools in this service. Saved values override legacy Config.deviceAddress, including an empty value that clears selection. Operations already dispatched keep their original address. A read/write failure is reported explicitly; no device operation silently falls back from corrupt saved settings. Saving again can repair corrupt settings. Keep this file and temporary `.recorder-settings-*.tmp` files private; do not commit them. Different profiles needing independent selections should use different dataDir values.
