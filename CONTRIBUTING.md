# Contributing

This is a plain-JavaScript DSH plugin in development preview. There is no build step. The manifest declares DSH peer dependencies; local regression tests use Node's built-in test runner and require no dependency installation. Read the [current status](README.md#current-status), [roadmap](ROADMAP.md), and [architecture](docs/architecture.md) before choosing work.

## Repository layout

```text
package.json                 Bundle and Client manifest
cordis.patch.yml             Loader entry
index.js                    Host Skill provider and internal CLI wrapper
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
node --check index.js
node --check client.js
node --check vendor/recorder-protocol.js
npm test
npm run check:package
git diff --check
```

On Windows PowerShell, if script execution policy blocks `npm.ps1`, use `npm.cmd test` and `npm.cmd run check:package`; no execution-policy change is needed. No dependency installation is required for these checks. To run only Node tests directly, use `node --test tests/*.test.js`.

Host contract tests check Skill metadata, cancellation, provider-owned locators, definition shape, resource paths, and manifest/Client module identity. They capture the provider rather than running the real Cordis registry. The package check runs `npm pack --dry-run --ignore-scripts`, verifies runtime entries, the complete upstream license and its attribution in both protocol copies, all local Skill references, and excluded content; it does not install or publish anything. npm cache/log output stays under the ignored `.cache/npm` directory.

The regression suite covers offset/fragmented `DataView` parsing, browser state updates, repeated list requests, idle/obsolete timers, write/setup failures, disconnection, switching devices, and unmount during connection setup. It also distinguishes no-response/partial-list timeouts from device completion and checks serialized writes during initialization and rapid cross-button clicks, including recovery after write failures and disconnects. Both characteristic write methods are exercised against a mock that rejects overlapping operations. The suite executes the registered Client component using simulated hooks, BLE events, and timers. It was verified with Node.js `v24.14.0`; this does not establish a minimum supported DSH runtime version.

These checks do not prove actual React/DSH integration, browser BLE behavior, or complete transfers. The list's 1.2-second idle threshold still needs hardware validation; timeout results are explicitly unconfirmed, not successful completion. The write queue serializes GATT write promises, not entire device command/response transactions. Review newly created files too: unstaged, untracked files are not covered by `git diff --check`.

List-response ambiguity tests cover retry attempts followed by late data/end frames in either order, stale button handlers, reconnection, old-session callbacks, and missing/nonzero completion status. After a timeout, list-write failure, or unconfirmed end response, same-session list retries are blocked; reconnect before retrying. Normal completion fixtures include the documented `2-18` status byte `0`.

When changing protocol or transfer behavior, add focused checks for observable behavior such as CRC vectors, fragmented frames, or incomplete imports. Prose-only changes need path, link, and capability-claim checks rather than hardware tests.

## Candidate DSH development loading procedure

This procedure has not yet been validated against a recorded DSH version. Do not present it as a supported installation path until milestone M1 passes.

The local `0.2.0-rc.2` source review and its limits are recorded in [M1 verification notes](docs/dsh-integration.md). Source evidence establishes candidate call shapes, not live profile availability.

1. Record the DSH version/build, profile, OS, Node runtime, and plugin commit or working-tree state. Minimum supported versions are still undetermined.
2. In an environment offering Creator mode / the `cordis` preset, inspect available development tools. If present, use `cordis_inspect_query` to confirm Skill, Service, Tool, Slot, Remote, and theme APIs before implementation.
3. If the environment exposes `plugin_manager` with `install_bundle`, inspect its schema and load this repository as the target directory. Record actual parameters; these names come from the scaffold and are not a verified cross-version contract.
4. Enable the plugin and verify that the card appears in the conversation and `recorder-card-bringup` is discoverable with its body readable.
5. Disable/re-enable the plugin and inspect errors, duplicate registrations, and resource cleanup. Record results rather than assuming cleanup is complete.

If a development API is absent, record the mismatch and resolve the target runtime before implementing against guessed interfaces.

## External CLI experiments

For isolated Host/CLI experiments, obtain the [upstream repository](https://github.com/nextproto1024/ai-recorder-card-open-protocol) separately and record its commit. Inspect that checkout's instructions, dependencies, scripts, and `--help` before installing dependencies or invoking device operations. Do not run `pip install -r tools/requirements.txt` from this plugin checkout: that file is not included.

The Host wrapper reads `python`, `repoRoot`, `deviceAddress`, and `outDir`; see the [configuration table](docs/architecture.md#current-host-configuration). These are implementation details, not a verified DSH configuration UI/schema. The wrapper is not exposed as Agent tools yet.

Use one BLE owner at a time. Disconnect the browser before starting a Python BLE session, and stop the Python session before reconnecting the browser. Keep output and credentials out of both repositories' commits.

## Hardware acceptance procedure

Use a disposable test recording without personal content. Record each result as pass, fail, or not tested, along with evidence.

1. **Connection:** connect/disconnect in the target browser; check permission rejection, device disconnection, and reconnect behavior.
2. **Status:** compare reported battery and recording state with the device; save sanitized response details when they differ.
3. **Recording:** start, pause, resume, and save; confirm the recording exists on the device.
4. **Listing:** compare filenames/count with known device contents, including empty and multi-frame lists. Verify no-response/partial-response timeouts show an uncertainty warning and block same-session retries. Deliver late data/end responses after attempting to retry; they must not produce a complete result. Disconnect, reconnect, and verify a fresh list can complete only with `2-18` status `0`. Missing/nonzero status must remain unconfirmed. Check on hardware whether old responses can be retransmitted across connections; callback isolation alone does not establish device behavior.
5. **Import (after implementation):** import one file; verify completion, size, playback, and preservation of the on-card original. Interrupt a transfer and confirm a partial file is not reported as complete.
6. **Transcription (after implementation):** verify one backend, transcript/audio association, repeat-import behavior, and retention of audio when transcription fails.

During connection initialization and recording, quickly click status refresh and list controls; confirm writes do not overlap or fail because another GATT write is pending. Repeat with a disconnect while commands are queued and verify the next connection does not execute old commands.

Steps 5–6 are future acceptance criteria. The current import button and planned `recorder_*` tools cannot complete them.

Copy this record into an issue or PR; omit secrets, device addresses, and personal audio/transcripts:

```text
Plugin revision / working-tree changes:
DSH version/build and profile:
OS / Node / browser version:
Card model / firmware:
BLE owner: browser or Python
External CLI commit / Python version (if used):
Scenario and exact steps:
Expected / actual result:
Result: pass / fail / not tested
Sanitized evidence or error:
Untested cases:
```

No supported environment baseline is recorded yet. Add the first reproducible passing baseline here when M1/M2 complete; expand compatibility claims only with evidence.

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
