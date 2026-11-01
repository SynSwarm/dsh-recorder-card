# Changelog

Record completed repository changes here. Future work and acceptance criteria live in [ROADMAP.md](ROADMAP.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbering follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Version `0.1.0` is recorded as an npm development-preview release; publication does not establish DSH or hardware compatibility.

## [Unreleased]

## [0.5.0] - 2026-11-02

- Correct Skill reference checks to exclude Markdown fragments when resolving local files; preserve the diagnostic section link.
- Add bounded transfer diagnostics for persistent operations and one-shot imports: stage durations, parsed data-frame/byte counters, first/last/end notification timing, queue wait and snapshot age. Preserve progress through timeout/cancellation and cleanup failures, carry it across Agent/Remote contracts, and atomically save the latest diagnostic under Host dataDir without audio, filenames or device identifiers. Offline coverage only; no new hardware acceptance claimed.
- Separate roadmap implementation, offline checks, hardware acceptance and release status; prioritize non-first import, transfer diagnostics and recovery. Retain recording-control compatibility requirements and add CI/upgrade configuration checks; align contributor guidance with the current shared Host workflow.
- Add exact on-card `filename` selection to `recorder_import` and a matching `importFile` Remote method; preserve default first-file import and staged, non-overwriting PCM publication. Named imports reuse the persistent Host session, including optional transcription.
- Distinguish observed disconnections from interrupted transfers with stable Agent/Remote error codes, retaining cleanup warnings. Recovery remains explicit reconnect and whole-file retry; byte resume and automatic batch recovery are not implemented.
- Document user-reported hardware workflow success, remaining transfer reliability work, and profile configuration checks before/after upgrades.
- Verify named import through a real isolated DSH Host Agent tool, complete WAV/hash integrity, retained connection and subsequent listing; the selected test file was first in the list, so non-first hardware acceptance remains pending. Clarify the protocol's 20-byte list-name truncation in Agent guidance.

## [0.4.0] - 2026-11-01

- Replace the expanding toolbar card with one connection icon and scoped conversation guidance, preserving composer drafts. Keep import, recording and transcription behind explicit conversation requests; expose disconnect/switch in a compact context menu.
- Add persistent Host BLE sessions and recorder_connect / recorder_disconnect tools. Reuse serialized device operations and distinguish intentionally retained connections from confirmed release in import results.
- Retire workers after unexpected disconnects; close stdin and wait for process/pipe closure before releasing the shared queue. Cancel unsent requests promptly without interrupting the active request.
- Preserve cleanup-unconfirmed terminal states, including idle cleanup failures and abnormal worker exits. Return CleanupError to affected queued callers before more BLE work, and retain warnings through Remote and the UI.
- Clarify DSH speech package availability, active-profile services and model readiness. Keep development-preview limitations and remaining physical-device acceptance explicit.

## [0.3.1] - 2026-11-01

- Recheck current audio bytes before returning cached transcripts or publishing archives; changed, truncated or removed inputs cannot succeed with a stale fingerprint.
- Reuse recognized text across moved/copied audio by publishing a separate archive bound to the current path and title. Preserve original archives and filename-derived timing provenance; prefer an existing archive for the exact current path.

## [0.3.0] - 2026-11-01

- Bundle pinned upstream Python CLI sources and their MIT notice; remove the default external checkout requirement. Python dependencies still need one-time installation.
- Add the Host Remote card and shared recorder Service, including cancellation and separate import/transcription/cleanup results.
- Add a device-address input with atomic persistence under dataDir and immediate use by both the card and Agent tools. Saved selection takes precedence over legacy Config; saving an empty address clears it.
- Implement default DSH speech-to-text, absent-service-only Doubao fallback, fingerprint-linked Markdown reuse, non-overwriting forced results and retained-audio failures. Verify real Host Gateway SenseVoice inference and Agent tool reuse; complete M4 acceptance remains pending.
- Validate the real DSH Web Client in Creator (`cordis`) mode; detailed evidence and hardware limits are recorded in `docs/client-host-remote.md`.

## Historical implementation notes (release allocation pending)

The notes below preserve earlier repository history. Some overlap the versioned entries above; allocation to early releases still requires comparison with their published tarballs. They are not additional unreleased features.

### Added

- Route the Client card through six cancellable Typert Remote methods and one injectable recorder Service shared with Agent tools. Ship Host/client descriptors, strict boundary validation, stage-aware import feedback and saved-audio transcription retry. Retire Web Bluetooth from the shipped Client; keep its historical regression fixture.

- Bundle unmodified NextProto CLI/protocol/transcription sources at commit `de42d1fbf19fc92064ac4688f71f42730c82267f`, with MIT notice, provenance and package checks. Remove the default external-checkout requirement; keep repoRoot as a developer override.
- Add Python dependency diagnostics and first-device configuration guidance. Separate dataDir (default `~/.dsh-recorder-card`) from installed sources for audio, corpus, device cache and ASR configuration. Relative paths now use dataDir; existing data is not migrated.

- Verify global recorder tools are inherited by local agent scopes, can dispatch a configuration-only check, and respect preset-scope restrictions. Confirm omitted Config paths/device identifiers remain optional under Schemastery; actual cordis-session presentation remains unverified.
- Reject truncated or unsupported audio before import publication/transcription by checking RIFF/WAVE PCM structure and whole frames. Preserve independent device cleanup status/errors alongside transcription failures in the version-2 import result.

- Protect imports with private staging and atomic no-replace publication; preserve same-name audio and add a unique suffix on collision. Report imported path/size/SHA-256 and separate transcription success/failure, including a retained-audio retry path. Fix the stale CLI validation status as a dated historical note.

- Register six CLI-backed Agent tools with Config validation, structured process results, stable failure codes and cancellation forwarding. Respect the configured import directory when the tool argument is omitted.
- Add eight tests using real Cordis/DSH registries and record M1 validation in an isolated DSH Desktop 0.2.0-rc.2 headless profile, including active synthetic child termination and disable/re-enable without duplicate tools or Skills. Hardware tool execution and DSH transcription remain pending.

- Add a shared Host device queue, argument validation, subprocess deadlines/output limits, cancellation and awaitable plugin disposal. Include real-process Windows tests for termination, queue recovery and blocked cleanup; live DSH/BLE cancellation and POSIX validation remain pending.

- Bundle a source-pinned Python device CLI adapter and offline behavior tests; route internal Host device methods through it and keep the external CLI separately installed.
- Record partial M2a hardware validation against pinned upstream CLI/protocol commit `de42d1fbf19fc92064ac4688f71f42730c82267f`: device discovery, status/list responses, and a selected test recording imported and fully decoded as WAV. Document pending acceptance and upstream response-validation gaps; no DSH integration claimed.
- Host Skill/manifest contract tests, an npm package preflight (`npm run check:package`), and an M1 source/verification record for the local DSH `0.2.0-rc.2` reference packages. Live Host and Slot verification remain pending.
- Bundled Skill runtime reference covering external CLI prerequisites and output locations without depending on repository-only developer documents.
- Dependency-free Node regression tests for notification parsing and simulated Client session/list lifecycle, available through `npm test`.
- Open-source independent developer and QA role guides, shared `AGENTS.md` routing, and Cursor rule entry points; roles distinguish implementation, review, and evidence-based acceptance.
- Initial plain-JavaScript bundle manifest, loader patch, and Host/Client entry points.
- Bundled `recorder-card-bringup` Skill and Host Skill-provider registration code; DSH integration remains unverified.
- Internal Host wrappers for external Python CLI scan, status, list, first-file import, recording control/state, and transcription. Python scripts are not bundled and Agent tools are not registered.
- Browser card implementation for BLE connection, battery/recording state, recording controls, and file listing; hardware behavior remains unverified.
- Vendored BLE protocol primitives in `vendor/recorder-protocol.js`.
- Browser import placeholder; transfer and Host persistence are not implemented.
- Milestone acceptance criteria in `ROADMAP.md` and runtime boundaries, configuration, and open decisions in `docs/architecture.md`.

### Changed

- Make Host Python CLI the documented main path; split standalone CLI validation (M2a) from DSH device tools (M2b), remove browser UI from M1 acceptance, and align environment, failure-recovery, and BLE ownership guidance. No runtime behavior or milestone acceptance changed.
- Remove hard-coded published versions from both READMEs so development-preview installation guidance stays current across patch releases.
- Reconciled documentation with the recorded npm development-preview release, clarified remaining release acceptance, and replaced an unavailable discoverability reference with an actionable checklist.
- Made `AGENTS.md` and `docs/roles/` the shared cross-tool entry and role definitions; documented explicit loading and retained `.cursor/rules/` as an optional Cursor adapter.
- Aligned English and Chinese READMEs with implementation and verification status; replaced unverified end-user installation claims with development guidance.
- Expanded contributor guidance with local checks, candidate DSH loading steps, and a reproducible hardware test record.
- Clarified Skill resource locations, external CLI prerequisites, and planned Agent tools; aligned the Host catalog description and removed claims of working provider selection and end-to-end archiving.

### Fixed

- Preserve failures from the first upstream disconnect attempt, including timeout/cancellation, even when upstream clears its client reference and a later cleanup call does nothing. Cover the pinned upstream Session implementation with offline regressions.
- Reject incomplete/malformed CLI lists and unacknowledged recording commands, prevent ambiguous same-session retries, and attempt bounded cleanup after device-operation timeout or failed connection setup. Host cross-process ownership and plugin-disable cleanup remain pending.
- Honor Skill load cancellation, restrict the provider to its owned locator, and return definitions without discovery-only fields. Removed the empty effect; DSH's Skill registry owns provider disposal.
- Replace unshipped local Skill documentation links with a packaged runtime reference; align README installation status and default transcription plan with the existing manifest and roadmap decisions.
- Distinguish file-list idle timeouts from device completion: show a persistent no-response or possibly-incomplete warning and identify confirmed empty lists separately.
- Block same-session list retries after timeout, list-write failure, or unconfirmed completion, requiring disconnect/reconnect so late responses cannot complete a retry. Validate the documented `2-18` success byte and cover late responses, stale handlers, and old-session callbacks in regression tests.
- Serialize all writes within each browser BLE session, including initialization, recording controls, status refresh, and list requests. A failed write does not poison later requests, and disconnected sessions cannot execute queued writes.
- Preserve byte offsets and lengths when converting `DataView` and other buffer views in both protocol implementations, allowing browser BLE notifications to be parsed.
- Keep one active file-list request, bind timeout callbacks to their collector, and clear them on completion, failure, disconnect, or unmount. Incoming list frames extend the UI idle fallback.
- Clear device-specific UI state on manual or unexpected disconnect; remove listeners, handle connection failures, and invalidate pending connections so stale callbacks cannot update a new session or an unmounted card.

## [0.1.1] - 2026-10-31

### Fixed

- Correct the npm package description, which displayed a README navigation line in `0.1.0`. Describe the plugin as a development preview; audio import and transcription integration remain planned.
- Include NextProto's complete MIT copyright and permission notice in `vendor/LICENSE`, with attribution in both protocol copies and package preflight enforcement.

DSH loading and hardware compatibility remain unverified; this release does not complete M1 or add the planned Agent tools, browser import, or transcription integration.

## [0.1.0] — Development preview

### Release record

- Recorded as published to npm in the project README and release checklist. The registry publication timestamp and exact shipped changes have not yet been independently verified; the release date is intentionally omitted until that evidence is available.
- DSH installation/activation and hardware compatibility remain unverified. Import, transcription, and archiving are not documented as a working end-to-end plugin workflow.
- Reconcile this entry against the registry timestamp, tarball integrity, and file contents before assigning the repository changes above to this release. See the [release checklist](RELEASE.md).
