# Installed runtime and external CLI prerequisites

This file is shipped with the recorder Skill. Developer architecture and contribution documents are maintained in the source repository and are not required to read this installed Skill.

## Execution locations

The browser card uses Bluetooth on the browser's machine. The Host runs Python on the DSH Host machine, which can be different. A remote Host does not automatically have access to the browser's Bluetooth hardware.

Use one BLE owner at a time. Disconnect the browser before running an external Python BLE session; stop that session before reconnecting the browser. Do not combine file import and realtime capture.

## Current Host wrapper

These fields are read by the current JavaScript wrapper. They are not yet a verified DSH configuration schema or callable Agent tool interface.

| Field | Default | Meaning |
|---|---|---|
| `python` | `python` | Interpreter available on the Host |
| `repoRoot` | Host `process.cwd()` | External checkout containing `tools/qs668-bringup.py` and `tools/qs668-transcribe.py`; also the subprocess working directory |
| `deviceAddress` | None | Passed as `--address` for device operations other than scanning; do not assume a missing value falls back to cached discovery |
| `outDir` | `archive/audio` | First-file import destination; relative paths resolve under `repoRoot` |

This package does not include the Python CLI, its dependencies, or upstream protocol documentation. Locate an external checkout and verify its revision, scripts, dependency instructions, and supported arguments before use. The wrapper does not install dependencies or initialize credentials.

The wrapper does not read `.env` itself. Subprocesses inherit the Host environment. Transcription currently invokes an external script with an audio path and optional `--force`; backend support depends on that script. The project has selected DSH speech-to-text as its default integration target, but the DSH backend and provider-selection setting are not implemented yet.

## Output and completion

Prefer explicit absolute input/output paths during verification. `archive/audio/` and `archive/corpus/` are intended locations, not a proven plugin-wide storage contract. Report the actual output path. A standalone CLI success does not prove DSH Agent tools or browser import are working.

Preserve imported audio when transcription fails. Do not reuse a transcript solely because a filename matches; require valid text and a matching `audio_sha256` when the chosen implementation supports reuse. Keep audio, transcripts, credentials, and device-address caches out of version control at the actual output location.

## Browser list recovery

After list timeout, write failure, or unconfirmed completion, the browser blocks same-session list retries. Disconnect and reconnect before reading again. Old-session notifications must not be used to confirm a new list. Device behavior across reconnections and timeout thresholds still require hardware validation.
