---
name: recorder-card-bringup
description: Guide AI recorder card (开源 AI 录音卡) connection, recording, import, and transcription in DSH, checking available tools and external CLI prerequisites first.
---

# AI recorder card bring-up

## Check capabilities first

This bundle is a development preview. It contains Skill registration code, a browser BLE card, and an internal Host CLI wrapper. It does not yet register `recorder_*` Agent tools or implement browser file import, Client–Host transfer, provider selection, or complete archiving.

Inspect the actual environment's tools before using them. If recorder tools are present in a later build, inspect their schemas and prefer them for supported operations. Do not invent a tool call from planned names below. A card rendering or a CLI running independently does not establish end-to-end plugin support.

## Locate resources

The Skill resource base is this `skill/` directory. Its parent is the installed plugin directory. The following resources are included in the npm package and resolve relative to this file:

- [Runtime and external CLI prerequisites](references/runtime.md): Host configuration, BLE ownership, output paths, and capability limits.
- [Protocol primitives](../vendor/recorder-protocol.js): the vendored JavaScript implementation.

If the runtime restricts access to the Skill resource base, use an available workspace reader to locate the plugin checkout; parent-relative references are not guaranteed to be accessible through the Skill provider. If required resources remain inaccessible, report the specific missing resource rather than fabricating its contents.

The [upstream protocol repository](https://github.com/nextproto1024/ai-recorder-card-open-protocol) is external. These paths refer to a separately obtained upstream checkout, **not this plugin**; verify them against the selected upstream revision before use:

- `docs/protocol.zh-CN.md` / `docs/protocol.md`: protocol specification.
- `tools/qs668-bringup.py`, `tools/qs668-transcribe.py`: device and transcription CLI.
- `tools/qs668_protocol.py`, `sdk/javascript/qs668-protocol.js`: protocol helpers.
- `docs/data-relationship.zh-CN.md` / `docs/data-relationship.md`: upstream storage conventions.

Record the upstream revision. Derive byte layouts from its specification; do not invent UUIDs, CRC parameters, byte order, or command bytes. If a needed field is undocumented, identify that gap before implementing the dependent operation. `website/app.js` is not a second protocol specification.

## Planned Agent interface

These names are roadmap targets, not currently registered tools:

| Planned tool | Intended operation |
|---|---|
| `recorder_scan` | Discover devices |
| `recorder_status` | Read device status |
| `recorder_list` | List recordings |
| `recorder_import` | Import audio; current internal wrapper only has first-file import |
| `recorder_record` | Control recording / read recording state |
| `recorder_transcribe` | Transcribe an imported file |

## External CLI workflow

Use the CLI only when the upstream checkout and dependencies are available and its actual scripts/arguments have been inspected. Do not run commands referencing `tools/` from this plugin directory. If no tools or external CLI are available, explain what is missing and complete any independent setup checks.

1. Locate the external checkout, verify dependency instructions and CLI `--help`, and identify an output directory. The Host wrapper expects `repoRoot` to contain the scripts; configuration fields are documented in `references/runtime.md`.
2. Ensure the intended machine has access to the device. Browser and Host may run on different machines. A person may need to power the card or grant Bluetooth access.
3. Disconnect the browser before a Python BLE session. Use one device owner at a time; stop the CLI session before reconnecting the browser.
4. Scan/read status and list recordings before selecting the requested import. Verify completion and the resulting file before reporting success.
5. If transcription is requested, inspect the external script's available backends and configuration first. Keep audio if transcription fails, and report import and transcription results separately.

The wrapper targets `--scan`, `--status`, `--list`, `--import-first --out`, `--record`, and `--record-state` on the bring-up script, and a file plus optional `--force` on the transcription script. Verify these mappings against the selected upstream version. Batch import, realtime capture, address caching, and backend-specific environment settings must be checked in that checkout; they are not implemented plugin guarantees.

## Device constraints

- Send `2-2` as one 36-byte GATT write; do not split it into 20 + 16.
- Keep separate frame buffers for AE22 and AE23 when handling both notification streams.
- Do not send on-card delete commands (`2-8`, `2-9`).
- Do not run file import and realtime audio at the same time.
- Do not create placeholder transcripts to imply transcription succeeded; preserve existing corpus files.
- Never commit credentials, device-address caches, audio, or transcripts. Check ignore rules at the actual output location, including external checkouts.

## Verify completion

For an import, inspect battery response (`0-4`), the accumulated file list (`2-1`), and successful transfer completion (end code `0`) where the verified CLI exposes them. A `DONE` line alone is insufficient: confirm the output path, completeness, and playback, and retain the on-card original.

The intended archive paths are `archive/audio/` and `archive/corpus/`; they are not yet a validated plugin storage contract. The Host wrapper resolves relative output under `repoRoot`. Report the actual location rather than assuming it is inside this plugin.

When the chosen transcription implementation supports reuse, require a non-empty transcript and matching `audio_sha256`; do not infer identity from a filename alone. Report which path was tested (standalone CLI or DSH integration) and which steps remain unverified.
