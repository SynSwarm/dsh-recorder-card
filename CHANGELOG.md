# Changelog

Record completed repository changes here. Future work and acceptance criteria live in [ROADMAP.md](ROADMAP.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Version numbering follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Version `0.1.0` is recorded as an npm development-preview release; publication does not establish DSH or hardware compatibility.

## [Unreleased]

The existing entries below describe completed repository work. Their allocation to `0.1.0` or a subsequent release is pending comparison with the published tarball; they must not be read as a verified diff from `0.1.0`. Once that comparison is available, move shipped changes to the versioned entry and leave only later work here.

### Added

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

- Reconciled documentation with the recorded npm development-preview release, clarified remaining release acceptance, and replaced an unavailable discoverability reference with an actionable checklist.
- Made `AGENTS.md` and `docs/roles/` the shared cross-tool entry and role definitions; documented explicit loading and retained `.cursor/rules/` as an optional Cursor adapter.
- Aligned English and Chinese READMEs with implementation and verification status; replaced unverified end-user installation claims with development guidance.
- Expanded contributor guidance with local checks, candidate DSH loading steps, and a reproducible hardware test record.
- Clarified Skill resource locations, external CLI prerequisites, and planned Agent tools; aligned the Host catalog description and removed claims of working provider selection and end-to-end archiving.

### Fixed

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
