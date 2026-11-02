# Contributing

This is a plain-JavaScript DSH plugin in development preview. There is no build step. A bundled Python adapter guards pinned CLI sources shipped under vendor/upstream. The manifest declares DSH peer dependencies; regression tests use Node's built-in test runner plus pinned DSH development dependencies for real registry tests. Read the [current status](README.md#current-status), [roadmap](ROADMAP.md), and [architecture](docs/architecture.md) before choosing work.

## Repository layout

```text
package.json                 Bundle and Client manifest
cordis.patch.yml             Loader entry
index.js                    Host Skill provider and internal CLI wrapper
runtime/recorder_cli.py      Pinned-source device CLI adapter
client.js                   Host Remote card (React supplied by DSH)
runtime/service.js          Shared injectable recorder Service
runtime/remote.js           Cancellable Remote controller
runtime/remote-contract.js  Shared strict wire schemas
typert.host.js              Loader-discovered Host descriptors
typert.remote-client.js     Client contribution
vendor/recorder-protocol.js  Vendored BLE protocol primitives
vendor/upstream/            Pinned Python CLI, license and provenance
tests/recorder.test.js       Protocol and retired browser lifecycle regressions
tests/remote.test.js         Official Client/Host Gateway integration
tests/client.test.js         Current card hooks and Remote calls
tests/host.test.js           Host Skill contract and manifest checks
scripts/check-package.mjs    npm package resource preflight
skill/SKILL.md              Agent workflow and resource guidance
docs/architecture.md        Runtime boundaries and open decisions
ROADMAP.md                  Milestones and acceptance criteria
AGENTS.md                   Tool-neutral collaboration and role entry point
docs/roles/                 Shared developer and QA responsibilities
.cursor/rules/              Optional Cursor adapters
```

Pinned Python CLI sources, requirements and MIT license are bundled under vendor/upstream. Python packages and upstream protocol documents remain external resources.

## Development and QA roles

Role selection is defined in [AGENTS.md](AGENTS.md). Responsibilities are maintained in two documents:

- [Open-source independent developer](docs/roles/open-source-developer.md): scope, implementation, self-checks, documentation, and delivery.
- [QA](docs/roles/qa.md): change review, verification evidence, findings, and acceptance conclusions.

The shared structure is independent of the editor:

```text
AGENTS.md
docs/roles/open-source-developer.md
docs/roles/qa.md
```

Tools that support the root `AGENTS.md` can use it as their entry point. Otherwise, explicitly ask the tool to read it, or reference it from that tool's project configuration. Automatic discovery is tool-dependent and must be verified in the actual environment.

The existing `.cursor/rules/` directory is an optional Cursor adapter; other tools do not need it. Keep adapters limited to references to the shared instructions, rather than copying role definitions. You can request a role explicitly, for example:

```text
先读取仓库根目录 AGENTS.md，以开源独立开发者角色推进 M1，完成实现和必要自检。
先读取仓库根目录 AGENTS.md，以 QA 角色审查当前工作区，包含未跟踪文件；只报告问题，不修改。
先读取仓库根目录 AGENTS.md，按 QA 角色审查，再修复确认的问题并复核。
```

These are responsibilities, not automatically launched agents. Review by the same implementer is a self-check, not independent QA. Review alone does not authorize commits, pushes, or publication; existing explicit authorization remains valid.

## Local checks without hardware

From the plugin repository root, run:

```sh
node --version
npm install --ignore-scripts --legacy-peer-deps --package-lock=false --cache .cache/npm
node --check index.js
node --check client.js
node --check vendor/recorder-protocol.js
npm test
npm run check:package
git diff --check
```

On Windows PowerShell, if script execution policy blocks `npm.ps1`, use `npm.cmd test` and `npm.cmd run check:package`; no execution-policy change is needed. Install the declared development dependencies first; `--legacy-peer-deps` avoids expanding the complete DSH application peer graph, and `--ignore-scripts` disables install hooks. To run only Node tests directly, use `node --test tests/*.test.js`.

Host contract tests mount real Cordis services and check Skill ownership, schemas, registration/disposal and shared tools/Remote dispatch. Remote tests load the official Client Gateway and Host Gateway with an in-process JSON carrier; card tests execute the current component through hooks. They cover malformed inputs/results, cancellation, unload, partial imports and transcription-only retry. They do not launch a browser or access BLE. The package check verifies every export, bundled CLI hashes, licenses, Skill references and excluded private/test content; it does not publish anything.

Historical Web Bluetooth regressions run `tests/fixtures/legacy-web-bluetooth.js`, which is excluded from the npm package. They preserve coverage for DataView parsing, timers, ambiguous list responses and GATT queues; they do not exercise the production Remote card.

When editing `runtime/remote-contract.js`, run `npm run sync:client` to copy its dependency-free factory into `client.js`. Commit both files. `npm test` checks for drift before running tests. This is a source synchronization step, not a TypeScript/bundler build; users need no build step. The codec implements the official `TypertSchema.parse` contract, while Config uses Schemastery.

These checks do not prove actual React/DSH integration, browser BLE behavior, or complete transfers. The list's 1.2-second idle threshold still needs hardware validation; timeout results are explicitly unconfirmed, not successful completion. The write queue serializes GATT write promises, not entire device command/response transactions. Review newly created files too: unstaged, untracked files are not covered by `git diff --check`.

List-response ambiguity tests cover retry attempts followed by late data/end frames in either order, stale button handlers, reconnection, old-session callbacks, and missing/nonzero completion status. After a timeout, list-write failure, or unconfirmed end response, same-session list retries are blocked; reconnect before retrying. Normal completion fixtures include the documented `2-18` status byte `0`.

When changing protocol or transfer behavior, add focused checks for observable behavior such as CRC vectors, fragmented frames, or incomplete imports. Prose-only changes need path, link, and capability-claim checks rather than hardware tests.

### Python adapter checks

Run `npm run test:cli` (PowerShell: `npm.cmd run test:cli`), or `python -m unittest discover -s tests -p "test_cli_adapter.py"`. The core offline tests require Python 3.11+ but no Bleak installation, external checkout, or device; pinned sources are bundled. Import regressions also exercise same-name and concurrent destination conflicts, staged failure/cancellation cleanup, unsupported atomic publication, and independent transcription results with synthetic local subprocesses; no cloud ASR is called. They cover confirmed/empty/multi-frame lists, malformed/truncated lists, idle/total timeouts, stale responses, recording acknowledgements, cancellation, failed initialization/cleanup, and source validation. The Node-only `npm test` command remains unchanged.

`PinnedSessionDisconnectTests` load the real Session class from the bundled pinned CLI, substituting only the hardware factory and client; no BLE connection or Bleak installation is needed. `RECORDER_UPSTREAM_ROOT` is an optional developer override. Missing/incorrect bundled sources fail; cases no longer skip without an external checkout. They verify that first-disconnect failure/cancellation cannot become success after upstream clears the client reference, including concurrent transcription failure and a successful-disconnect control case. Report whether these cases ran when reviewing cleanup changes.

Host process tests start dedicated Node fixture processes, without Python, Bluetooth or transcription services. They exercise cross-instance queueing, queued/active cancellation, process-tree termination, deadlines/output limits, cleanup failure and reuse prevention after disposal. Windows must permit `taskkill /T /F`; a restricted sandbox may need an authorized local run. POSIX termination remains unverified. Capturing `ctx.effect` in tests checks the cleanup contract, not real DSH unload/reload.

For actual device experiments, use the [bundled adapter](skill/references/runtime.md#bundled-cli-adapter) with its bundled pinned sources. Internal Host device methods use the same entry point. Direct use of the original CLI bypasses these response checks; label such evidence separately.

## Candidate DSH development loading procedure

M1 passed in the recorded Windows DSH Desktop 0.2.0-rc.2 isolated headless environment. See the [reproduction record](docs/dsh-integration.md); this is not verification of the published npm package or desktop UI.

The local `0.2.0-rc.2` source review and its limits are recorded in [M1 verification notes](docs/dsh-integration.md). Source evidence establishes candidate call shapes, not live profile availability.

1. Record the DSH version/build, profile, OS, Node runtime, and plugin commit or working-tree state. Minimum supported versions are still undetermined.
2. In an environment offering Creator mode / the `cordis` preset, inspect available development tools. If present, use `cordis_inspect_query` to confirm Host loading and Skill APIs for M1. Confirm Service/Tool APIs for M2b; Slot, Remote, and theme checks belong to optional UI work.
3. If the environment exposes `plugin_manager` with `install_bundle`, inspect its schema and load this repository as the target directory. Record actual parameters; these names come from the scaffold and are not a verified cross-version contract.
4. Enable the Host plugin and verify that `recorder-card-bringup` is discoverable, with its body and bundled resources readable. Card rendering is an optional check, not an M1 gate. If current Client dependencies prevent Host loading, resolve that coupling before claiming M1 passed.
5. Disable/re-enable the plugin and inspect errors, duplicate providers, and Host resource cleanup. Record results rather than assuming cleanup is complete; inspect Client cleanup separately when testing the optional UI.

If a development API is absent, record the mismatch and resolve the target runtime before implementing against guessed interfaces.

## External CLI experiments

The first partial hardware run is recorded in [M2a validation notes](docs/cli-validation.md), including the pinned upstream revision, successful scan/read/import evidence, and unverified edge cases. It does not establish DSH integration.

M2a can run independently of M1. Use the machine intended to run the DSH Host: it must have working Bluetooth hardware, permissions, and access to the card. Record the OS, adapter/driver, Python and Bleak versions, and pinned CLI commit; choose an explicit interpreter and writable absolute output directory. Do not infer compatibility from another machine or from browser success.

For isolated Host/CLI experiments, use bundled `vendor/upstream/tools/` sources. Install Python 3.11+ and run `python -m pip install bleak requests` (or `python -m pip install -r vendor/upstream/tools/requirements.txt`). Run `python -B runtime/recorder_cli.py --check-deps` and `python -B runtime/recorder_cli.py -- --help` before device operations. No clone, automatic dependency installation or pnpm policy change is needed. `vendor/upstream/SOURCE.json` records provenance; package checks validate every copied file and its MIT notice.

The Host wrapper reads `python`, optional source override `repoRoot`, `dataDir`, `deviceAddress`, `outDir`, and `cliTimeoutMs`; the shared recorder service also selects `transcriptionProvider` (default `dsh`). See the [configuration table](docs/architecture.md#current-host-configuration). Eight tools are registered. The current UI uses a connection icon and conversation-based selection; the address input belongs to earlier releases. Full hardware tool acceptance remains pending. Transcription tests use the official speech service registry with synthetic recognizers; actual SenseVoice and archive-reuse evidence is separate in [M4 validation](docs/transcription-validation.md).

Use one BLE owner at a time. The current Client and Agent tools share the Host session; do not disconnect it before an ordinary tool import. Release it before a separate CLI experiment, and disconnect external direct-BLE browsers or phone apps before Host access. Keep output and credentials out of Git.

## Hardware acceptance procedure

Use a disposable test recording without personal content. Record each result as pass, fail, or not tested, along with evidence. Follow the [roadmap](ROADMAP.md) distinction between implementation, offline checks, hardware acceptance and publication. Unconfirmed recording controls remain a compatibility requirement; they do not prevent validating the import/transcription path for existing recordings, and must not be silently marked passed.

### Main path: independent CLI, then DSH tools

1. **Environment and ownership (M2a):** complete the Python prerequisites above and inspect actual `--help`. Disconnect any browser BLE session and stop other CLI sessions before testing.
2. **Discovery and status (M2a):** scan and select the intended card; retain its identifier only in local configuration. Compare battery, capacity, firmware, and recording state with the device using the selected CLI's supported commands.
3. **Recording and listing (M2a):** start, pause, resume, and save a disposable recording; confirm it exists. Test empty/multi-frame lists, no response, and partial responses. An incomplete or ambiguous result must not be reported as a complete list.
4. **Early import experiment (M2a):** import one test recording into an explicit output directory. Check device completion, size, playback, and preservation of the on-card original. This can be attempted after scan/status/list to assess feasibility early; it does not satisfy M3.
5. **Failures (M2a):** exercise unavailable devices, connection errors, disconnects, timeout, cancellation, and retry after failure. Record exit status and whether the process/connection is released. Missing CLI behavior remains a failed or pending criterion.
6. **DSH device tools (M2b, with M1 loading and the relevant M2a device baseline):** verify actual tool schemas and configuration, then repeat discovery/status/recording/listing through DSH, tracking each operation separately. Check invalid paths/arguments, structured errors, same-device concurrent calls, timeout, cancellation, plugin disable cleanup, and recovery. Do not blindly repeat a recording command whose execution outcome is uncertain. Local process tests do not replace physical BLE checks.
7. **DSH import (M3, using the M2b shared service):** verify selection, final path, completeness, playback and audio hash. The workspace supports exact `filename` from the list, including its possibly truncated extension; omission selects the first file. Explicitly test a non-first entry, then authorized long recordings and sequential selections. Record stage timings and bytes; a transfer-progress stream is not yet implemented. Verify connection retention, interruption, cancellation and explicit reconnect/retry; partial files and name conflicts must not overwrite valid audio or be reported as successful. See [hardware evidence and limits](docs/import-recovery.md).
8. **DSH transcription (M4, using complete imported audio):** the default `dsh` integration and local SenseVoice have implementation and real Host evidence. Verify transcript/audio association, reuse, name conflicts and retained audio on failure in the current candidate. Existing-audio transcription can be checked independently, but end-to-end acceptance requires selection, import, transcription and archive reuse in a documented build.

CLI commands and arguments must be verified against the pinned upstream revision. Standalone CLI evidence supports M2a only; M2b–M4 require real DSH tool calls. Browser rendering is not a prerequisite for this path.

### Optional Host Remote card checks

Verify the conversation activity Slot and theme in real DSH, then click Scan and confirm the operation runs on the Host without a browser Bluetooth picker. Save the returned identifier using the card's device-address input, verify immediate use and persistence across page/Host restart, then verify status/list output. Settings writes must preserve the previous file/address on failure and reject invalid identifiers. After explicit permission to use a test recording, validate first-file import, partial/transcription/cleanup messages, saved-audio retry, cancellation and plugin unload. Recording controls remain firmware-dependent and must not auto-retry. Do not use status polling as progress: it launches another BLE operation.

Current evidence and exact interface are in [Client–Host Remote](docs/client-host-remote.md). In-process Gateway and hook tests do not prove desktop rendering, live network authentication or hardware behavior. Retired browser direct-connect code is only a test fixture; restoring it would need fresh device-ownership and browser acceptance.

## Implementation conventions

- Follow the upstream protocol; do not invent UUIDs, CRC parameters, byte order, or command bytes. Record the upstream revision used for protocol changes.
- The shipped Client has no BLE protocol implementation. The retired browser copy remains only in test fixtures; maintain current CLI/protocol behavior against a pinned upstream revision.
- Use `--dsw-alias-*` theme tokens; do not import `@deepseek-ai/dsh-client-ui-*` packages into the UI. Manifest injection declarations are separate from UI imports.
- Register resources within `apply(ctx)` with `ctx.effect` and cleanup; component effects also need cleanup for sessions, listeners, and timers.
- Preserve the [Skill's device constraints](skill/SKILL.md#device-constraints), including no on-card deletion and no simultaneous import/realtime capture.
- Never commit `.env`, recordings, transcripts, or device-address caches. Review staged content before committing.

## Documentation and change reporting

- Keep English and Chinese README sections, status, and instructions aligned.
- For repository metadata, directory submissions and community drafts, use the [discovery and promotion checklist](docs/discovery-and-promotion.md). Recheck channel rules at submission time; retain hardware requirements and distinguish published capabilities from workspace changes and acceptance evidence.
- Update roadmap status using acceptance evidence; code alone is not a passed hardware milestone.
- Keep completed changes in `CHANGELOG.md`; do not list planned backends or tools as working features.
- Keep Skill frontmatter and the Host's `SKILL_DESCRIPTION` aligned.
- Explain changes, verification, and untested behavior in each PR. Include the reproduction record above in issues.
