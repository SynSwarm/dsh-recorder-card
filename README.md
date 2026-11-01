# dsh-recorder-card

[中文](README.zh.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

**`dsh-recorder-card`** is a third-party **DeepSeek Harness (DSH)** plugin under development for connecting **AI recorder cards** over BLE.

> **Development preview:** the current build contains Host tools, bundled CLI sources, safe import, default DSH transcription and fingerprint-linked archives. Real DSH Host checks passed local SenseVoice transcription and tool reuse; full hardware acceptance remains incomplete. These features belong to the 0.3.0 development-preview release; earlier npm versions differ.

## Purpose

The intended workflow is to record meetings, interviews, or notes on a dedicated device, transfer audio over BLE, and archive it with a transcript in DSH. Hardware recording does not use the computer's microphone.

The implementation follows the [upstream AI recorder card protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol). Support for a particular card or firmware must be verified; a shared product name alone does not establish compatibility.

The main path is **DSH Host → bundled Python CLI → recorder card**, with Bluetooth access on the Host machine. Eight Agent tools and the connection icon share one Host service through Typert Remote, without Web Bluetooth.

**New in 0.4.0:** a single connection icon and persistent Host BLE session, with recording workflows handled through conversation. Version `0.3.1` uses the previous settings card. This remains a development preview.

**Workspace addition, not yet released:** `recorder_import` accepts an exact on-card `filename`; omission retains first-file behavior. It reuses the held Host session without an external CLI or connection handoff. A real DSH Agent named import, complete audio verification and retained connection passed. That test recording happened to be first in the list; non-first selection and interruption recovery still need hardware verification. See the [acceptance record](docs/import-recovery.md).

If connection cleanup fails, the icon retains an unconfirmed-release warning. Pending device work fails before accessing BLE; inspect the card before explicitly retrying. A disconnected process alone is not proof of successful device cleanup.

## Current status

“Implemented” means code exists, not that it has passed DSH or hardware testing. The recorded Host baseline is DSH Desktop 0.2.0-rc.2 on Windows, using an isolated headless profile.

| Capability | Implementation | Verification / remaining work |
|---|---|---|
| Bundle manifest and Skill provider | Implemented | M1 passed in an isolated DSH profile: loading, Skill access, disable/re-enable and child cleanup |
| Single connection icon and conversation guidance | Implemented in 0.4.0 | Native desktop connection color, guidance submission and draft preservation pass; model reply, physical drops and multiple physical cards remain pending |
| Import through conversation | First-file import released; exact list-name selection implemented in the workspace | Real DSH Agent named import and retained connection pass; test file was first in list, so non-first selection and interruption recovery remain pending |
| Browser direct BLE | Retired from the shipped Client | Previous implementation retained only as a regression fixture |
| Host Python CLI calls | Pinned-source adapter and process manager | Internal listing hardware smoke test and local queue/cancellation tests pass; DSH lifecycle verified; hardware tool acceptance pending, pinned CLI sources now bundled; no separate clone required |
| `recorder_*` Agent device tools | Eight tools registered, typed configuration and structured process results | Schema/error/cancellation tests pass; real Host transcription/reuse pass; hardware import/control remain pending |
| Client–Host communication for optional UI | Twelve methods in the workspace; eleven in 0.4.0 | Adds `importFile`; see [Remote design and validation](docs/client-host-remote.md); no transfer-progress stream |
| Transcription providers and archive integrity | Safe audio/Markdown publication, fingerprint reuse and separate stage results implemented | Real Host SenseVoice transcription and tool reuse pass; full hardware recovery remains pending |

See [ROADMAP.md](ROADMAP.md) for acceptance criteria. A [partial standalone CLI hardware run](docs/cli-validation.md) verified scan/status/list responses and a single-file transfer with complete WAV decoding; the user confirmed correct playback/content, while recording controls and remaining acceptance cases are pending. A later internal Host listing smoke test passed. Remote recording start remained unacknowledged; a physical-button recording appeared in the confirmed list. Full DSH tool acceptance remains pending.

Import now preserves same-name audio, publishes complete staged files under a unique name when needed, and returns separate import/transcription states. Publication requires verified RIFF/WAVE PCM structure; truncated or unsupported audio remains unconfirmed. Transcription failure or unconfirmed connection cleanup returns `status: partial` with independent stage details; this is not full workflow success. See the [runtime contract](skill/references/runtime.md#safe-import-and-separate-transcription-results).

Local regressions cover the actual official Client/Host Gateways over an in-process JSON carrier, card hooks, cancellation, partial imports, and service sharing with Agent tools. Legacy browser BLE tests remain as historical regressions. Run `npm test`; see [local checks](CONTRIBUTING.md#local-checks-without-hardware) for limits.

Click the recorder icon to reconnect the saved card, or scan on first use. One discovered card connects automatically; multiple cards require a choice in the conversation. Gray means disconnected, pulsing means connecting, and green means Host-confirmed BLE connection. Click again while connecting to cancel. Connection success sends a guidance request to the current conversation without changing the composer draft. Use conversation commands for listing, first-file import and optional transcription. Right-click or Shift+F10 exposes disconnect and switch-device actions. No settings form expands in the toolbar. Cloud transcription fallback uploads audio and requires explicit transcription intent.

## Installation and first use

These instructions target 0.4.0 or later. Versions 0.3.x use the previous settings card; older releases may require an external checkout. Install with:

```sh
dsh plugin add dsh-recorder-card
python -m pip install bleak requests
```

The Host needs Python 3.11+, Bluetooth hardware and permission. The pinned Python CLI is bundled: no upstream clone or `repoRoot` setting is needed. If `python` is not on the DSH PATH, configure the plugin's `python` field with the absolute path of the same interpreter.

1. Wake the card and disconnect other Bluetooth clients. Click the recorder icon or ask the Agent to call `recorder_connect`. A unique device connects and is remembered automatically; multiple candidates require your choice.
2. Ask in the conversation to list recordings or disconnect. Use the icon's context menu to switch devices, or call `recorder_connect` with an empty address to scan afresh. Advanced `deviceAddress` configuration remains a fallback. npm 0.3.1 users still use the original card's device-address input.
3. Call `recorder_list` and select an authorized recording. Released 0.4.0 imports only the first file; this workspace supports `recorder_import({ "filename": "exact name from list" })`. Omit `filename` for the first file; transcription defaults off. For multiple selected recordings, call sequentially and stop on transfer errors; no external CLI is needed.
4. Audio defaults to `~/.dsh-recorder-card/archive/audio/` on the Host; use the absolute path returned by the tool. Optional transcription needs a prepared DSH recognizer, or credentials for Doubao cloud ASR. Scanning and importing need no ASR credentials.

When DSH/pnpm sets `minimumReleaseAge=1440`, a new release may be unavailable for its first 24 hours. Wait for the release to mature; do not disable that policy.

Before upgrading, back up the active profile's `cordis.patch.yml` and `package.json`; compare custom settings afterward and verify the chosen model and speech service. Reported configuration loss has not been reproduced and is not established as expected upgrade behavior. See [upgrade checks](docs/import-recovery.md#profile-upgrade).

New error codes distinguish `RECORDER_DEVICE_DISCONNECTED` (an observed disconnect) from `RECORDER_TRANSFER_INTERRUPTED` (incomplete transfer without confirmed disconnection). Inspect the device, reconnect, then explicitly retry that file from the beginning. Byte resume and automatic reconnection are not implemented. Resolve unconfirmed cleanup first; if audio was imported but transcription failed, retry transcription only.

The workspace also adds transfer diagnostics: phase timings, received frame/byte counts and the age of the last snapshot on interruption. Host saves the latest diagnostic to `dataDir/recorder-diagnostics.json`, without audio, filenames or device identifiers. These counters are not a completion percentage or proof of audio integrity; there is no UI progress stream. See [diagnostic fields and limits](docs/import-recovery.md#transfer-diagnostics). This addition has offline verification only.

Install Python dependencies once using the same interpreter configured in the plugin. Alternatively, from the installed plugin directory run `python -m pip install -r vendor/upstream/tools/requirements.txt`. Missing-dependency errors name the active interpreter and installation command. From the installed plugin directory, `python -B runtime/recorder_cli.py --check-deps` checks setup without Bluetooth access. See the [distribution validation record](docs/distribution-validation.md) for tested environments and remaining acceptance.

## Development requirements

- A DSH environment exposing plugin development capabilities; supported versions/profiles are not established yet.
- For the optional icon: DSH Client Gateway, sessions/conversation services and the conversation input-left Slot. Bluetooth hardware and permission are required on the Host.
- Node.js for syntax checks; the minimum version remains to be established with the target DSH runtime.
- For the Host CLI main path: Python 3.11+ and Bleak/requests. Pinned scripts and requirements are shipped under `vendor/upstream/tools/`.

## First development check

1. Follow the [local checks](CONTRIBUTING.md). Prepare Python/Bleak, check the bundled CLI, and enable Bluetooth access on the intended Host machine.
2. Start M2a independently: scan, read status/list, and import/play one non-personal test recording, then complete recording controls and failure scenarios. DSH loading is not a prerequisite.
3. Reproduce [M1 Host validation](docs/dsh-integration.md) on the target environment. The isolated Windows baseline passed; card rendering remains a separate optional check.
4. With M1 loading and the relevant M2a device baseline, follow M2b → M3 → M4 for tools, import and transcription. Track recording-control compatibility separately while advancing the existing-recording workflow. Record implementation, offline and hardware results separately; standalone CLI success does not establish a working plugin workflow.

## Architecture

| Component | File | Current role |
|---|---|---|
| Host | [index.js](index.js) | Skill/tools, shared injectable recorder Service and Remote controller |
| Agent tools | [runtime/tools.js](runtime/tools.js) | Six CLI-backed tools; process completion is separate from device/file verification |
| Host process manager | [runtime/host-cli.js](runtime/host-cli.js) | Shared device queue, argument checks, deadlines, cancellation and disposal; live DSH validation pending |
| CLI adapter | [runtime/recorder_cli.py](runtime/recorder_cli.py) | External source validation, list/record confirmations, per-process timeouts and connection cleanup |
| Client | [client.js](client.js) | React card calling Host Remote; no browser BLE ownership |
| Skill | [skill/SKILL.md](skill/SKILL.md) | Capability checks, resource locations, and device constraints |
| Protocol | [vendor/recorder-protocol.js](vendor/recorder-protocol.js) | CRC, frames, parsers, and command primitives |
| Loader | [cordis.patch.yml](cordis.patch.yml) | Plugin loader entry |

See [architecture and open decisions](docs/architecture.md) for BLE ownership, bundled CLI configuration, and planned data flow.

## Transcription and archives

Fixes in 0.3.1: recheck current audio bytes before returning a cached result. Moving/copying identical audio reuses the text in a separate archive with the current audio path/title, preserving old archives. Inferred timing remains tied to the original source, recorded in `transcription_source_audio` / `recorded_at_source_audio`; these are historical provenance, not current audio links.

`transcriptionProvider` defaults to `dsh`, using the Host's `speechToText` service and selected recognizer, not necessarily a DeepSeek cloud API. Check three conditions separately: the Host can load the packages, the active profile mounts the service and recognizer, and the selected recognizer is ready. Installing packages alone does not satisfy the latter two conditions.

The official `@deepseek-ai/dsh-experimental-speech-to-text` package provides the service. The verified local recognizer comes from `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` and requires configuration and prepared models. These packages are not shipped with this plugin but may be included in DSH; install compatible versions separately only when the Host lacks them. The inspected Windows DSH Desktop `0.2.0-rc.2` includes these packages, but its default `dsh-base` / `dsh-web-app` bundles do not reference them. Our real test mounted them through an additional profile patch; see [M4 validation](docs/transcription-validation.md). Check other versions separately. `@deepseek-ai/dsh-experimental-api-speech-to-text` provides the official speech Remote interface; configure it when needed by the corresponding speech UI. It is not a hard dependency of this plugin's direct transcription calls.

Only an absent `speechToText` service falls back to bundled Doubao cloud ASR; an unregistered recognizer, unprepared models, recognition failures or cancellation in an existing service never trigger fallback. Explicit `doubao` is also supported: it uploads audio and needs Host environment or `dataDir/.env` credentials. OpenAI and a standalone `local` provider remain future work.

Success includes `provider`, `recognizer`, the Markdown `path`, `audioSha256` and `reused`. Failure retains audio for a separate `recorder_transcribe` retry. DSH returns plain text without segment timestamps or diarization; the archive labels filename-derived start time (unknown timezone) and default speaker “说话人1” as inferred values.

## Data layout

```text
archive/audio/    # imported audio
archive/corpus/   # transcript Markdown
```

Archives use `audio_sha256`, provider, recognizer and language for reuse, with body integrity checked before reuse. Empty results are rejected; same-name different audio cannot reuse the wrong result. `force: true` creates a new archive and preserves existing files. Relative output and transcription input paths resolve under `dataDir`, defaulting to `~/.dsh-recorder-card` on the Host. `repoRoot` only selects CLI source. Device cache and optional `.env` also live in the data directory, not the installed package. Transcription currently accepts complete canonical 44-byte-header, 16 kHz mono PCM16 WAV up to 64 MiB; recognizers may impose smaller limits. No automatic splitting or resampling is performed.

Keep audio, transcripts, device addresses, and credentials out of version control. See [.gitignore](.gitignore); check external checkouts' ignore rules too.

## Contributing

For AI-assisted collaboration, start with [AGENTS.md](AGENTS.md) and the [developer](docs/roles/open-source-developer.md) or [QA](docs/roles/qa.md) role. These documents are shared across tools; `.cursor/rules/` is an optional Cursor adapter. See [role setup](CONTRIBUTING.md#development-and-qa-roles) for explicit loading instructions when a tool does not discover the entry point automatically.

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep this README and [README.zh.md](README.zh.md) aligned when behavior or status changes. Completed changes belong in [CHANGELOG.md](CHANGELOG.md); future work belongs in [ROADMAP.md](ROADMAP.md).

## License and related projects

[MIT](LICENSE) © 2026 SynSwarm DAO.

The bundled Python CLI and vendored protocol include code from NextProto's AI recorder card open protocol, © 2026 NextProto, under the [upstream MIT license](vendor/LICENSE). This notice is included in the npm package. The retired browser implementation remains in the test fixtures with attribution.

- [AI recorder card open protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol): external protocol and CLI source.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): intended host runtime.
