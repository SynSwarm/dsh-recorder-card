# dsh-recorder-card

[中文](README.zh.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

**`dsh-recorder-card`** is a third-party **DeepSeek Harness (DSH)** plugin under development for connecting **AI recorder cards** over BLE.

> **Development preview:** the repository contains a plugin skeleton and browser card implementation. Import, transcription, and archive integration are not complete. Host loading and lifecycle have passed in an isolated DSH 0.2.0-rc.2 profile; hardware and end-to-end acceptance remain incomplete. These workspace changes are not yet published. Published on npm as `dsh-recorder-card` (development preview).

## Purpose

The intended workflow is to record meetings, interviews, or notes on a dedicated device, transfer audio over BLE, and archive it with a transcript in DSH. Hardware recording does not use the computer's microphone.

The implementation follows the [upstream AI recorder card protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol). Support for a particular card or firmware must be verified; a shared product name alone does not establish compatibility.

The main path is **DSH Host → Python CLI → recorder card**, with Bluetooth access on the Host machine. The browser Web Bluetooth card is optional. The Host registers six CLI-backed Agent tools; registration is verified, while device operations through DSH still need hardware acceptance.

## Current status

“Implemented” means code exists, not that it has passed DSH or hardware testing. The recorded Host baseline is DSH Desktop 0.2.0-rc.2 on Windows, using an isolated headless profile.

| Capability | Implementation | Verification / remaining work |
|---|---|---|
| Bundle manifest and Skill provider | Implemented | M1 passed in an isolated DSH profile: loading, Skill access, disable/re-enable and child cleanup |
| Browser connection, battery, recording state and controls | Implemented (optional enhancement, demoted) | Verify Web Bluetooth availability, permissions, and hardware in the target browser; not on the critical path |
| Browser file listing | Implemented (optional enhancement, demoted) | Same as above; not on the critical path |
| Browser file import | Placeholder | Button only displays a message; transfer and Host persistence are missing |
| Host Python CLI calls | Pinned-source adapter and process manager | Internal listing hardware smoke test and local queue/cancellation tests pass; DSH lifecycle verified; hardware tool acceptance pending, external CLI still required |
| `recorder_*` Agent device tools | Six tools registered, typed configuration and structured process results | Schema/error/cancellation tests pass; hardware import/control and default DSH transcription remain pending |
| Client–Host communication for optional UI | Not implemented | Future UI reads status and sends commands through Host |
| Transcription providers and archive integrity | Safe audio publication and separate stage results implemented | DSH transcription, transcript reuse and full archive acceptance pending |

See [ROADMAP.md](ROADMAP.md) for acceptance criteria. A [partial standalone CLI hardware run](docs/cli-validation.md) verified scan/status/list responses and a single-file transfer with complete WAV decoding; the user confirmed correct playback/content, while recording controls and remaining acceptance cases are pending. A later internal Host listing smoke test passed. Remote recording start remained unacknowledged; a physical-button recording appeared in the confirmed list. Full DSH tool acceptance remains pending.

Import now preserves same-name audio, publishes complete staged files under a unique name when needed, and returns separate import/transcription states. Publication requires verified RIFF/WAVE PCM structure; truncated or unsupported audio remains unconfirmed. Transcription failure or unconfirmed connection cleanup returns `status: partial` with independent stage details; this is not full workflow success. See the [runtime contract](skill/references/runtime.md#safe-import-and-separate-transcription-results).

Local regressions cover notification parsing, session/list cleanup, incomplete-list timeout warnings, and serialized session writes using simulated hooks and BLE. Run `npm test`; see [local checks](CONTRIBUTING.md#local-checks-without-hardware) for coverage and limits. These checks do not replace DSH or real-device verification.

In the optional browser direct-connection mode, after a list timeout, write failure, or unconfirmed end response, disconnect and reconnect before reading the list again. Same-session retries are blocked to avoid treating late responses as a new complete list. Received entries remain explicitly unconfirmed; status and recording controls remain available.

## Installation status

There is currently no verified end-user installation procedure documented here.

- **Local development:** follow the candidate DSH loading procedure in [CONTRIBUTING.md](CONTRIBUTING.md), then record the exact runtime version and results.
- **npm:** published as `dsh-recorder-card`; install spec `dsh plugin add dsh-recorder-card`. End-user installation and activation in DSH have not been verified yet.
- **GitHub / Web UI installation:** bundle installation and activation have not been verified. User instructions will follow release acceptance.

## Development requirements

- A DSH environment exposing plugin development capabilities; supported versions/profiles are not established yet.
- For browser experiments: Chrome or Edge with `navigator.bluetooth` available, Bluetooth access, and a protocol-compatible card. Record the actual browser/OS combination tested.
- Node.js for syntax checks; the minimum version remains to be established with the target DSH runtime.
- For the Host CLI main path: a separate upstream checkout, Python, and that checkout's declared dependencies. This repository contains no `tools/` directory or Python requirements file.

## First development check

1. Follow the [local checks](CONTRIBUTING.md). Prepare a pinned external CLI, Python/Bleak, and Bluetooth access on the intended Host machine.
2. Start M2a independently: scan, read status/list, and import/play one non-personal test recording, then complete recording controls and failure scenarios. DSH loading is not a prerequisite.
3. Reproduce [M1 Host validation](docs/dsh-integration.md) on the target environment. The isolated Windows baseline passed; card rendering remains a separate optional check.
4. After M1 and M2a pass, follow M2b → M3 → M4 for DSH device tools, single-file import, and default transcription. Standalone CLI success does not establish a working plugin workflow.

## Architecture

| Component | File | Current role |
|---|---|---|
| Host | [index.js](index.js) | Skill and tool registration, configuration; Client transport pending |
| Agent tools | [runtime/tools.js](runtime/tools.js) | Six CLI-backed tools; process completion is separate from device/file verification |
| Host process manager | [runtime/host-cli.js](runtime/host-cli.js) | Shared device queue, argument checks, deadlines, cancellation and disposal; live DSH validation pending |
| CLI adapter | [runtime/recorder_cli.py](runtime/recorder_cli.py) | External source validation, list/record confirmations, per-process timeouts and connection cleanup |
| Client | [client.js](client.js) | React card using browser BLE; import placeholder |
| Skill | [skill/SKILL.md](skill/SKILL.md) | Capability checks, resource locations, and device constraints |
| Protocol | [vendor/recorder-protocol.js](vendor/recorder-protocol.js) | CRC, frames, parsers, and command primitives |
| Loader | [cordis.patch.yml](cordis.patch.yml) | Plugin loader entry |

See [architecture and open decisions](docs/architecture.md) for BLE ownership, external CLI configuration, and planned data flow.

## Transcription plan

The selected default integration target is DSH speech-to-text; Doubao, an OpenAI-compatible ASR endpoint, and local SenseVoice ONNX are optional future backends. These are not supported provider options today. The Host method only invokes an external script; it does not implement the DSH backend, provider selection, or a `transcriptionProvider` setting. M4 implements and validates the selected default before expanding support.

## Data plan

```text
archive/audio/    # intended destination for imported audio
archive/corpus/   # intended destination for transcript Markdown
```

The intended relationship uses `audio_sha256` to associate transcripts with audio and prevent unsafe reuse. This repository does not yet implement or validate that storage contract. Relative output paths in the Host wrapper resolve under its configured `repoRoot`, which may be an external checkout.

Keep audio, transcripts, device addresses, and credentials out of version control. See [.gitignore](.gitignore); check external checkouts' ignore rules too.

## Contributing

For AI-assisted collaboration, start with [AGENTS.md](AGENTS.md) and the [developer](docs/roles/open-source-developer.md) or [QA](docs/roles/qa.md) role. These documents are shared across tools; `.cursor/rules/` is an optional Cursor adapter. See [role setup](CONTRIBUTING.md#development-and-qa-roles) for explicit loading instructions when a tool does not discover the entry point automatically.

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep this README and [README.zh.md](README.zh.md) aligned when behavior or status changes. Completed changes belong in [CHANGELOG.md](CHANGELOG.md); future work belongs in [ROADMAP.md](ROADMAP.md).

## License and related projects

[MIT](LICENSE) © 2026 SynSwarm DAO.

The vendored protocol and its inline copy in `client.js` include code from NextProto's AI recorder card open protocol, © 2026 NextProto, under the [upstream MIT license](vendor/LICENSE). This notice is included in the npm package.

- [AI recorder card open protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol): external protocol and CLI source.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): intended host runtime.
