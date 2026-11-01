# dsh-recorder-card

[中文](README.zh.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

**`dsh-recorder-card`** is a third-party **DeepSeek Harness (DSH)** plugin under development for connecting **AI recorder cards** over BLE.

> **Development preview:** the current build contains Host tools, bundled CLI sources, safe import, default DSH transcription and fingerprint-linked archives. Real DSH Host checks passed local SenseVoice transcription and tool reuse; full hardware acceptance remains incomplete. These features belong to the 0.3.0 development-preview release; earlier npm versions differ.

## Purpose

The intended workflow is to record meetings, interviews, or notes on a dedicated device, transfer audio over BLE, and archive it with a transcript in DSH. Hardware recording does not use the computer's microphone.

The implementation follows the [upstream AI recorder card protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol). Support for a particular card or firmware must be verified; a shared product name alone does not establish compatibility.

The main path is **DSH Host → bundled Python CLI → recorder card**, with Bluetooth access on the Host machine. Both the six Agent tools and the optional Client card use the same Host service. The card now calls Typert Remote; it does not use Web Bluetooth.

## Current status

“Implemented” means code exists, not that it has passed DSH or hardware testing. The recorded Host baseline is DSH Desktop 0.2.0-rc.2 on Windows, using an isolated headless profile.

| Capability | Implementation | Verification / remaining work |
|---|---|---|
| Bundle manifest and Skill provider | Implemented | M1 passed in an isolated DSH profile: loading, Skill access, disable/re-enable and child cleanup |
| Client scan, status, listing and recording controls | Host Remote implemented | Real DSH Web Creator-mode rendering, settings and scan pass; recording controls and Electron-specific checks remain pending |
| Client first-file import | Host Remote implemented | Real Web Client import passes: 5.28-second WAV, complete decoding and hash match to user-approved test audio; cancellation/retry still pending |
| Browser direct BLE | Retired from the shipped Client | Previous implementation retained only as a regression fixture |
| Host Python CLI calls | Pinned-source adapter and process manager | Internal listing hardware smoke test and local queue/cancellation tests pass; DSH lifecycle verified; hardware tool acceptance pending, pinned CLI sources now bundled; no separate clone required |
| `recorder_*` Agent device tools | Six tools registered, typed configuration and structured process results | Schema/error/cancellation tests pass; real Host transcription/reuse pass; hardware import/control remain pending |
| Client–Host communication for optional UI | Six device/ASR methods plus two persistent device-setting methods | See [Remote design and validation](docs/client-host-remote.md); no live progress stream |
| Transcription providers and archive integrity | Safe audio/Markdown publication, fingerprint reuse and separate stage results implemented | Real Host SenseVoice transcription and tool reuse pass; full hardware recovery remains pending |

See [ROADMAP.md](ROADMAP.md) for acceptance criteria. A [partial standalone CLI hardware run](docs/cli-validation.md) verified scan/status/list responses and a single-file transfer with complete WAV decoding; the user confirmed correct playback/content, while recording controls and remaining acceptance cases are pending. A later internal Host listing smoke test passed. Remote recording start remained unacknowledged; a physical-button recording appeared in the confirmed list. Full DSH tool acceptance remains pending.

Import now preserves same-name audio, publishes complete staged files under a unique name when needed, and returns separate import/transcription states. Publication requires verified RIFF/WAVE PCM structure; truncated or unsupported audio remains unconfirmed. Transcription failure or unconfirmed connection cleanup returns `status: partial` with independent stage details; this is not full workflow success. See the [runtime contract](skill/references/runtime.md#safe-import-and-separate-transcription-results).

Local regressions cover the actual official Client/Host Gateways over an in-process JSON carrier, card hooks, cancellation, partial imports, and service sharing with Agent tools. Legacy browser BLE tests remain as historical regressions. Run `npm test`; see [local checks](CONTRIBUTING.md#local-checks-without-hardware) for limits.

Click the microphone icon to scan through the Host, then save the identifier in the card's device-address input before status, list or import. Scanning does not create a persistent connection. Import targets the first recording only; importing and transcribing are separate buttons. Transcription sends audio to the ASR backend configured on the Host.

## Installation and first use

These instructions target 0.3.0 or later; older releases may require an external checkout. Install with:

```sh
dsh plugin add dsh-recorder-card
python -m pip install bleak requests
```

The Host needs Python 3.11+, Bluetooth hardware and permission. The pinned Python CLI is bundled: no upstream clone or `repoRoot` setting is needed. If `python` is not on the DSH PATH, configure the plugin's `python` field with the absolute path of the same interpreter.

1. Ask the DSH Agent to read this plugin's Skill and call `recorder_scan`, which requires no device address. Wake the card and disconnect phone/browser clients first.
2. In the card, click **设置设备 (Device settings)**, paste your card's identifier into **设备地址 (Device address)** and click **保存设备地址 (Save)**. It takes effect immediately and survives restart; no YAML edit or reload is required. The saved selection overrides the legacy `deviceAddress` fallback. Save an empty value to clear the selection.
3. Call `recorder_list`, confirm the first recording may be imported, then call `recorder_import` (transcription defaults off). Only first-file import is currently exposed.
4. Audio defaults to `~/.dsh-recorder-card/archive/audio/` on the Host; use the absolute path returned by the tool. Optional transcription needs a prepared DSH recognizer, or credentials for Doubao cloud ASR. Scanning and importing need no ASR credentials.

When DSH/pnpm sets `minimumReleaseAge=1440`, a new release may be unavailable for its first 24 hours. Wait for the release to mature; do not disable that policy.

Install Python dependencies once using the same interpreter configured in the plugin. Alternatively, from the installed plugin directory run `python -m pip install -r vendor/upstream/tools/requirements.txt`. Missing-dependency errors name the active interpreter and installation command. From the installed plugin directory, `python -B runtime/recorder_cli.py --check-deps` checks setup without Bluetooth access. See the [distribution validation record](docs/distribution-validation.md) for tested environments and remaining acceptance.

## Development requirements

- A DSH environment exposing plugin development capabilities; supported versions/profiles are not established yet.
- For the optional card: DSH Client Gateway and the conversation activity Slot. Bluetooth hardware and permission are required on the Host, not in the browser.
- Node.js for syntax checks; the minimum version remains to be established with the target DSH runtime.
- For the Host CLI main path: Python 3.11+ and Bleak/requests. Pinned scripts and requirements are shipped under `vendor/upstream/tools/`.

## First development check

1. Follow the [local checks](CONTRIBUTING.md). Prepare Python/Bleak, check the bundled CLI, and enable Bluetooth access on the intended Host machine.
2. Start M2a independently: scan, read status/list, and import/play one non-personal test recording, then complete recording controls and failure scenarios. DSH loading is not a prerequisite.
3. Reproduce [M1 Host validation](docs/dsh-integration.md) on the target environment. The isolated Windows baseline passed; card rendering remains a separate optional check.
4. After M1 and M2a pass, follow M2b → M3 → M4 for DSH device tools, single-file import, and default transcription. Standalone CLI success does not establish a working plugin workflow.

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

Workspace fixes (unreleased, not in npm 0.3.0): recheck current audio bytes before returning a cached result. Moving/copying identical audio reuses the text in a separate archive with the current audio path/title, preserving old archives. Inferred timing remains tied to the original source, recorded in `transcription_source_audio` / `recorded_at_source_audio`; these are historical provenance, not current audio links.

`transcriptionProvider` defaults to `dsh`, using the Host's `speechToText` service and selected recognizer, not necessarily a DeepSeek cloud API. DSH's SenseVoice runs locally after its models are prepared. Only an absent service falls back to bundled Doubao cloud ASR; readiness, recognition and cancellation failures never trigger fallback. Explicit `doubao` is also supported: it uploads audio and needs Host environment or `dataDir/.env` credentials. OpenAI and a standalone `local` provider remain future work.

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
