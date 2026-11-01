---
name: recorder-card-bringup
description: Guide AI recorder card (开源 AI 录音卡) connection, recording, import, and transcription in DSH, checking available tools and Python prerequisites first.
---

# AI recorder card bring-up

## Check capabilities first

This bundle is a development preview. It contains Skill registration, a Host Remote card, and a bundled Host CLI wrapper. It registers six `recorder_*` Agent tools over the shared recorder service. Host loading, Skill discovery and disable/re-enable passed in an isolated DSH 0.2.0-rc.2 profile; Client–Host Gateway dispatch and a real Web Creator-mode scan/settings/first-file import are verified; real Host local SenseVoice transcription and Agent reuse pass. Full Agent hardware operations, recording controls and end-to-end recovery remain unaccepted.

Inspect the actual environment's tools before using them. If recorder tools are present, inspect their schemas and prefer them for supported operations. Do not invent a tool call from names below. A card rendering or a CLI running independently does not establish end-to-end plugin support.

## Locate resources

The Skill resource base is this `skill/` directory. Its parent is the installed plugin directory. The following resources are included in the npm package and resolve relative to this file:

- [Runtime and Python prerequisites](references/runtime.md): Host configuration, BLE ownership, output paths, and capability limits.
- [Protocol primitives](../vendor/recorder-protocol.js): the vendored JavaScript implementation.
- [CLI adapter](../runtime/recorder_cli.py): validates the bundled pinned sources and requires confirmed list/record responses; usage and limits are in the runtime reference.

If the runtime restricts access to the Skill resource base, use an available workspace reader to locate the plugin checkout; parent-relative references are not guaranteed to be accessible through the Skill provider. If required resources remain inaccessible, report the specific missing resource rather than fabricating its contents.

The [upstream protocol repository](https://github.com/nextproto1024/ai-recorder-card-open-protocol) is external. Device/transcription Python scripts are included under [vendor/upstream](../vendor/upstream/README.md) at the recorded commit. The following reference paths belong to the upstream repository; protocol documents and the JavaScript SDK are not shipped:

- `docs/protocol.zh-CN.md` / `docs/protocol.md`: protocol specification.
- `tools/qs668-bringup.py`, `tools/qs668-transcribe.py`: device and transcription CLI.
- `tools/qs668_protocol.py`, `sdk/javascript/qs668-protocol.js`: protocol helpers.
- `docs/data-relationship.zh-CN.md` / `docs/data-relationship.md`: upstream storage conventions.

Record the upstream revision. Derive byte layouts from its specification; do not invent UUIDs, CRC parameters, byte order, or command bytes. If a needed field is undocumented, identify that gap before implementing the dependent operation. `website/app.js` is not a second protocol specification.

## Agent interface

The current workspace build registers the tools below; older published builds may not. Most values report process completion, not complete hardware acceptance. `recorder_import` returns separate import/transcription states: `status: partial` means audio was retained but transcription failed or connection cleanup is unconfirmed. Inspect both `transcription` and `cleanup`; retry only an indicated transcription step, not import, and do not start another BLE operation until release is confirmed. Recording start is unconfirmed on the tested firmware; inspect state before deciding how to recover from an unacknowledged command.

| Tool | Operation and limits |
|---|---|
| `recorder_scan` | Discover devices |
| `recorder_status` | Read device status |
| `recorder_list` | List recordings |
| `recorder_import` | Import the first listed file only; optional transcription requires explicit user intent and runs after BLE cleanup |
| `recorder_record` | Control recording / read recording state |
| `recorder_transcribe` | Default DSH speech-to-text and hash-linked Markdown; only absent service falls back to Doubao cloud ASR; returns actual path/provider/reuse state |

## First-time setup and CLI workflow

No upstream clone or repoRoot configuration is required. Install Python 3.11+ and `python -m pip install bleak requests` on the Host. Use the same interpreter in the plugin `python` setting when it is not on PATH. Use the bundled adapter rather than running upstream scripts directly.

1. Inspect available recorder tools and current plugin Config. Run `recorder_scan` without deviceAddress; ask the user to identify their card if several are found, then guide them to the card's Device settings button and device-address input. Saving there persists under dataDir and takes effect immediately, with no YAML edit or reload. The saved choice overrides the legacy Config fallback; saving an empty address clears it. Do not invent a plugin_manager config action. This device field is required before status/list/record/import; scan and standalone transcription work without it. Never publish identifiers in repository files or shared logs.
2. Ensure the intended machine has access to the device. Browser and Host may run on different machines. A person may need to power the card or grant Bluetooth access.
3. Disconnect phone apps, browser direct-BLE sessions and external CLI sessions before device operations. The current card UI and Agent tools share the Host service and its queue; the UI does not own a browser BLE connection.
4. Scan/read status and list recordings before selecting the requested import. A successful process exit alone is insufficient: scanning may return no devices, lists require a successful end response, and recording requires the corresponding acknowledgement. On unconfirmed recording, read device state before deciding what to do; never blindly repeat start. Verify transfer completion and the resulting file before reporting success.
5. If transcription is requested, check `transcriptionProvider` (default `dsh`) and the Host speech service first. Prepare local models through DSH when needed. Only absent `speechToText` falls back to Doubao cloud ASR, which uploads audio and requires credentials; model errors or cancellation never trigger fallback. Keep audio if transcription fails, and report import and transcription results separately. Check `recorder_import.status`, `import.integrity`, `transcription`, and `cleanup` even when DSH dispatch itself returned successfully; use the returned retry path for a partial result. Treat filename-derived times and the default speaker label as inferred metadata, not recognized facts.

The wrapper targets `--scan`, `--status`, `--list`, `--import-first --out`, `--record`, and `--record-state` on the bring-up script, and a file plus optional `--force` on the transcription script. Verify these mappings against the selected upstream version. Batch import, realtime capture, address caching, and backend-specific environment settings must be checked against the bundled source; they are not implemented plugin guarantees.

## Device constraints

- Send `2-2` as one 36-byte GATT write; do not split it into 20 + 16.
- Keep separate frame buffers for AE22 and AE23 when handling both notification streams.
- Do not send on-card delete commands (`2-8`, `2-9`).
- Do not run file import and realtime audio at the same time.
- Do not create placeholder transcripts to imply transcription succeeded; preserve existing corpus files.
- Never commit credentials, device-address caches, audio, or transcripts. Check ignore rules at the actual output location, including the configured data directory.

## Verify completion

For an import, inspect battery response (`0-4`), the accumulated file list (`2-1`), and successful transfer completion (end code `0`) where the verified CLI exposes them. A `DONE` line alone is insufficient: confirm the output path, completeness, and playback, and retain the on-card original.

The default data root is `~/.dsh-recorder-card` on the Host, configurable as `dataDir`; it contains `archive/audio/`, `archive/corpus/`, device cache and optional `.env`. Relative output and transcription input resolve under `dataDir`. CLI sources remain separate. Report the actual location rather than assuming it is inside this plugin.

When the chosen transcription implementation supports reuse, require a non-empty transcript and matching `audio_sha256`; do not infer identity from a filename alone. Report which path was tested (standalone CLI or DSH integration) and which steps remain unverified.
