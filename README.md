# dsh-recorder-card

[中文](README.zh.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Architecture](docs/architecture.md) · [Changelog](CHANGELOG.md)

**`dsh-recorder-card`** is a third-party **DeepSeek Harness (DSH)** plugin under development for connecting **AI recorder cards** over BLE.

> **Development preview:** the repository contains a plugin skeleton and browser card implementation. Import, transcription, and archive integration are not complete. DSH compatibility and hardware behavior still need verification. Published on npm as `dsh-recorder-card` (development preview).

## Purpose

The intended workflow is to record meetings, interviews, or notes on a dedicated device, transfer audio over BLE, and archive it with a transcript in DSH. Hardware recording does not use the computer's microphone.

The implementation follows the [upstream AI recorder card protocol](https://github.com/nextproto1024/ai-recorder-card-open-protocol). Support for a particular card or firmware must be verified; a shared product name alone does not establish compatibility.

## Current status

“Implemented” means code exists, not that it has passed DSH or hardware testing. No verified compatibility baseline is recorded yet.

| Capability | Implementation | Verification / remaining work |
|---|---|---|
| Bundle manifest and Skill provider | Implemented; local contract/package checks pass | Verify loading and Skill discovery in DSH |
| Browser connection, battery, recording state and controls | Implemented | Verify in the target browser with a real card |
| Browser file listing | Implemented | Verify multi-frame lists and completion handling |
| Browser file import | Placeholder | Button only displays a message; transfer and Host persistence are missing |
| Host Python CLI calls | Wrapper implemented | CLI is not bundled; configuration and execution need verification |
| `recorder_*` Agent tools and Client–Host communication | Not implemented | Registration and transport APIs need confirmation |
| Transcription providers and archive integrity | Planned | No complete plugin workflow or verified default provider |

See [ROADMAP.md](ROADMAP.md) for acceptance criteria.

Local regressions cover notification parsing, session/list cleanup, incomplete-list timeout warnings, and serialized session writes using simulated hooks and BLE. Run `npm test`; see [local checks](CONTRIBUTING.md#local-checks-without-hardware) for coverage and limits. These checks do not replace DSH or real-device verification.

After a list timeout, write failure, or unconfirmed end response, disconnect and reconnect before reading the list again. Same-session retries are blocked to avoid treating late responses as a new complete list. Received entries remain explicitly unconfirmed; status and recording controls remain available.

## Installation status

There is currently no verified end-user installation procedure documented here.

- **Local development:** follow the candidate DSH loading procedure in [CONTRIBUTING.md](CONTRIBUTING.md), then record the exact runtime version and results.
- **npm:** published as `dsh-recorder-card`; install spec `dsh plugin add dsh-recorder-card`. End-user installation and activation in DSH have not been verified yet.
- **GitHub / Web UI installation:** bundle installation and activation have not been verified. User instructions will follow release acceptance.

## Development requirements

- A DSH environment exposing plugin development capabilities; supported versions/profiles are not established yet.
- For browser experiments: Chrome or Edge with `navigator.bluetooth` available, Bluetooth access, and a protocol-compatible card. Record the actual browser/OS combination tested.
- Node.js for syntax checks; the minimum version remains to be established with the target DSH runtime.
- For Host CLI experiments only: a separate upstream checkout, Python, and that checkout's declared dependencies. This repository contains no `tools/` directory or Python requirements file.

## First development check

1. Follow the local checks and candidate DSH loading procedure in [CONTRIBUTING.md](CONTRIBUTING.md).
2. Verify that the card renders and the bundled Skill is discoverable.
3. With a real device, verify connection, status, recording controls, and file listing separately.
4. Record failures and environment details. Import and transcription are future acceptance steps, not working quick-start commands.

## Architecture

| Component | File | Current role |
|---|---|---|
| Host | [index.js](index.js) | Skill registration and internal Python CLI wrapper; tools/transport pending |
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
