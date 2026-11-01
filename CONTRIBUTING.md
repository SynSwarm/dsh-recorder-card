# Contributing

This is a plain-JavaScript DSH plugin in development preview. There is no build step. A small bundled Python adapter guards the separately obtained device CLI. The manifest declares DSH peer dependencies; regression tests use Node's built-in test runner plus pinned DSH development dependencies for real registry tests. Read the [current status](README.md#current-status), [roadmap](ROADMAP.md), and [architecture](docs/architecture.md) before choosing work.

## Repository layout

```text
package.json                 Bundle and Client manifest
cordis.patch.yml             Loader entry
index.js                    Host Skill provider and internal CLI wrapper
runtime/recorder_cli.py      Pinned-source device CLI adapter
client.js                   Browser BLE card; import is a placeholder
vendor/recorder-protocol.js  Vendored BLE protocol primitives
tests/recorder.test.js       Protocol and simulated browser lifecycle regressions
tests/host.test.js           Host Skill contract and manifest checks
scripts/check-package.mjs    npm package resource preflight
skill/SKILL.md              Agent workflow and resource guidance
docs/architecture.md        Runtime boundaries and open decisions
ROADMAP.md                  Milestones and acceptance criteria
AGENTS.md                   Tool-neutral collaboration and role entry point
docs/roles/                 Shared developer and QA responsibilities
.cursor/rules/              Optional Cursor adapters
```

The Python CLI and upstream protocol documents are external dependencies, not files in this tree.

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

Host contract tests check Skill metadata, cancellation, provider-owned locators, definition shape, resource paths, and manifest/Client module identity. The original fixtures capture the provider; `tests/tools.test.js` additionally mounts real Cordis, Skill and Tool registries and checks registration/disposal, schemas, errors and cancellation. The package check runs `npm pack --dry-run --ignore-scripts`, verifies runtime entries, the complete upstream license and its attribution in both protocol copies, all local Skill references, and excluded content; it does not install or publish anything. npm cache/log output stays under the ignored `.cache/npm` directory.

The regression suite covers offset/fragmented `DataView` parsing, browser state updates, repeated list requests, idle/obsolete timers, write/setup failures, disconnection, switching devices, and unmount during connection setup. It also distinguishes no-response/partial-list timeouts from device completion and checks serialized writes during initialization and rapid cross-button clicks, including recovery after write failures and disconnects. Both characteristic write methods are exercised against a mock that rejects overlapping operations. The suite executes the registered Client component using simulated hooks, BLE events, and timers. It was verified with Node.js `v24.14.0`; this does not establish a minimum supported DSH runtime version.

These checks do not prove actual React/DSH integration, browser BLE behavior, or complete transfers. The list's 1.2-second idle threshold still needs hardware validation; timeout results are explicitly unconfirmed, not successful completion. The write queue serializes GATT write promises, not entire device command/response transactions. Review newly created files too: unstaged, untracked files are not covered by `git diff --check`.

List-response ambiguity tests cover retry attempts followed by late data/end frames in either order, stale button handlers, reconnection, old-session callbacks, and missing/nonzero completion status. After a timeout, list-write failure, or unconfirmed end response, same-session list retries are blocked; reconnect before retrying. Normal completion fixtures include the documented `2-18` status byte `0`.

When changing protocol or transfer behavior, add focused checks for observable behavior such as CRC vectors, fragmented frames, or incomplete imports. Prose-only changes need path, link, and capability-claim checks rather than hardware tests.

### Python adapter checks

Run `npm run test:cli` (PowerShell: `npm.cmd run test:cli`), or `python -m unittest discover -s tests -p "test_cli_adapter.py"`. The core offline tests require Python but no Bleak installation, external checkout, or device. Import regressions also exercise same-name and concurrent destination conflicts, staged failure/cancellation cleanup, unsupported atomic publication, and independent transcription results with synthetic local subprocesses; no cloud ASR is called. They cover confirmed/empty/multi-frame lists, malformed/truncated lists, idle/total timeouts, stale responses, recording acknowledgements, cancellation, failed initialization/cleanup, and source validation. The Node-only `npm test` command remains unchanged.

Additional `PinnedSessionDisconnectTests` load the real Session class from the source-verified external checkout, substituting only the hardware factory and client; no BLE connection or Bleak installation is needed. Set `RECORDER_UPSTREAM_ROOT` to that checkout, or place it at `.cache/upstream/ai-recorder-card-open-protocol`. These cases explicitly skip when the default checkout is absent; a configured but missing/incorrect checkout fails. They verify that first-disconnect failure/cancellation cannot become success after upstream clears the client reference, including concurrent transcription failure and a successful-disconnect control case. Report whether these cases ran when reviewing cleanup changes.

Host process tests start dedicated Node fixture processes, without Python, Bluetooth or transcription services. They exercise cross-instance queueing, queued/active cancellation, process-tree termination, deadlines/output limits, cleanup failure and reuse prevention after disposal. Windows must permit `taskkill /T /F`; a restricted sandbox may need an authorized local run. POSIX termination remains unverified. Capturing `ctx.effect` in tests checks the cleanup contract, not real DSH unload/reload.

For actual device experiments, use the [bundled adapter](skill/references/runtime.md#bundled-cli-adapter) with the pinned external checkout. Internal Host device methods use the same entry point. Direct use of the original CLI bypasses these response checks; label such evidence separately.

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

For isolated Host/CLI experiments, obtain the [upstream repository](https://github.com/nextproto1024/ai-recorder-card-open-protocol) separately and record its commit. Inspect that checkout's instructions, dependencies, scripts, and `--help` before installing dependencies or invoking device operations. Do not run `pip install -r tools/requirements.txt` from this plugin checkout: that file is not included.

The Host wrapper reads `python`, `repoRoot`, `deviceAddress`, `outDir`, and `cliTimeoutMs`; see the [configuration table](docs/architecture.md#current-host-configuration). These fields are exported in the plugin Config schema. Six CLI-backed tools are registered; desktop configuration UI and hardware tool acceptance remain pending.

Use one BLE owner at a time. Disconnect the browser before starting a Python BLE session, and stop the Python session before reconnecting the browser. Keep output and credentials out of both repositories' commits.

## Hardware acceptance procedure

Use a disposable test recording without personal content. Record each result as pass, fail, or not tested, along with evidence.

### Main path: independent CLI, then DSH tools

1. **Environment and ownership (M2a):** complete the external CLI prerequisites above and inspect actual `--help`. Disconnect any browser BLE session and stop other CLI sessions before testing.
2. **Discovery and status (M2a):** scan and select the intended card; retain its identifier only in local configuration. Compare battery, capacity, firmware, and recording state with the device using the selected CLI's supported commands.
3. **Recording and listing (M2a):** start, pause, resume, and save a disposable recording; confirm it exists. Test empty/multi-frame lists, no response, and partial responses. An incomplete or ambiguous result must not be reported as a complete list.
4. **Early import experiment (M2a):** import one test recording into an explicit output directory. Check device completion, size, playback, and preservation of the on-card original. This can be attempted after scan/status/list to assess feasibility early; it does not satisfy M3.
5. **Failures (M2a):** exercise unavailable devices, connection errors, disconnects, timeout, cancellation, and retry after failure. Record exit status and whether the process/connection is released. Missing CLI behavior remains a failed or pending criterion.
6. **DSH device tools (M2b, after M1 and M2a):** verify actual tool schemas and configuration, then repeat discovery/status/recording/listing through DSH. Check invalid paths/arguments, structured errors, same-device concurrent calls, timeout, cancellation, plugin disable cleanup, and recovery. Do not blindly repeat a recording command whose execution outcome is uncertain. The internal Host process manager now has local tests for queueing, cancellation and disposal; real DSH and BLE behavior still requires these checks.
7. **DSH import (M3, after M2b):** invoke the import tool and verify its file selection scope, progress, final path, completeness, playback, and audio hash. Interrupt and retry; partial files and name conflicts must not overwrite valid audio or be reported as successful. The current wrapper only targets first-file import.
8. **DSH transcription (M4, after M3):** verify the selected default `dsh` backend, transcript/audio association, reuse and name conflicts, and retention of audio on failure. This integration is not implemented yet.

CLI commands and arguments must be verified against the pinned upstream revision. Standalone CLI evidence supports M2a only; M2b–M4 require real DSH tool calls. Browser rendering is not a prerequisite for this path.

### Optional browser direct-connection checks

Test this mode separately after Python has released the device. Confirm Slot/rendering, Web Bluetooth availability, browser permissions, connection/disconnection/reconnection, battery, recording controls, and empty/multi-frame lists. DSH page authentication depends on the actual environment; a token URL alone does not establish Bluetooth access.

Retain the browser-specific regressions: no-response/partial-list timeouts must warn and block same-session retries; late data/end frames after a retry attempt must not yield a complete result. Reconnect and confirm a fresh list only with `2-18` status `0`; missing/nonzero status remains unconfirmed. Check whether firmware retransmits old responses across connections. During initialization and recording, click different controls quickly to verify serialized writes; disconnect with queued commands and confirm the next session does not execute them. Disable/re-enable and unmount to check listener/session cleanup.

Browser direct BLE is an alternative device owner, not a simultaneous monitor for the CLI. A future UI may read Host state and send Host commands, but that communication is not implemented. Browser file import remains a placeholder.

Copy this record into an issue or PR; omit secrets, device addresses, and personal audio/transcripts:

```text
Plugin revision / working-tree changes:
Validation path and milestone: standalone CLI / DSH tools / optional browser
DSH version/build and profile (N/A for standalone CLI):
Host machine / OS / Bluetooth adapter and driver:
Node / browser version (if applicable):
Card model / firmware:
BLE owner: browser or Python
External CLI commit / Python / Bleak versions:
Interpreter / script / output paths (sanitized):
Scenario and exact steps:
Exit status / process and connection cleanup:
Expected / actual result:
Result: pass / fail / not tested
Sanitized evidence or error:
Untested cases:
```

No supported environment baseline is recorded yet. Record M1, M2a, M2b, and optional browser baselines separately as they pass; expand compatibility claims only with evidence.

## Implementation conventions

- Follow the upstream protocol; do not invent UUIDs, CRC parameters, byte order, or command bytes. Record the upstream revision used for protocol changes.
- The browser has an inline protocol implementation as well as the vendored module. Review both when changing protocol behavior.
- Use `--dsw-alias-*` theme tokens; do not import `@deepseek-ai/dsh-client-ui-*` packages into the UI. Manifest injection declarations are separate from UI imports.
- Register resources within `apply(ctx)` with `ctx.effect` and cleanup; component effects also need cleanup for sessions, listeners, and timers.
- Preserve the [Skill's device constraints](skill/SKILL.md#device-constraints), including no on-card deletion and no simultaneous import/realtime capture.
- Never commit `.env`, recordings, transcripts, or device-address caches. Review staged content before committing.

## Documentation and change reporting

- Keep English and Chinese README sections, status, and instructions aligned.
- Update roadmap status using acceptance evidence; code alone is not a passed hardware milestone.
- Keep completed changes in `CHANGELOG.md`; do not list planned backends or tools as working features.
- Keep Skill frontmatter and the Host's `SKILL_DESCRIPTION` aligned.
- Explain changes, verification, and untested behavior in each PR. Include the reproduction record above in issues.
