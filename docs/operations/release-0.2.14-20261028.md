# GeoD Agent 0.2.14 release — 2026-10-28

Status: published. Source commit `30c0e69162175ef9a4f71ede00d6d95f2586092b`. [GitHub release](https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.14).

The release covers effective CRS/format conflict reuse, saved task conditions, background recovery, source metadata inspection, Chinese history decoding and consent-scoped download diagnostics. Exact scope and limitations are in `docs/releases/0.2.14.md`.

Validation: native library 221 passed / 23 external-condition ignored; frontend 451 passed / zero skipped; TypeScript and two analytics tests passed. Retained same-day real-model planning evidence was matched against the release app/native/protocol sources. SDK verification passed nine cases without installing; signed package payload verified 13318 runtime files.

Build provenance: the first signing supervisor retained a failed raw-byte runtime-inventory gate. All tracked build sources were unchanged; six UTF-8 runtime text files had CRLF/LF normalization, with corresponding manifest serialization/hash updates. The original receipt and snapshot remain intact. `build/equivalent-result.json` separately records the reviewed exception, pinned to that original receipt and the pre-build manifests. The reviewer rechecks newline-only equivalence, rejects executable/configuration/metadata changes, and verifies every current runtime file. Five targeted rejection/acceptance tests and 23 release-flow regressions passed. The signed candidate was reused without recompiling or changing it.

Online verification: GitHub is public and stable; canonical origin and CDN update indexes and both language pages select 0.2.14. The release used upload receipts and local signatures/payload hashes; full paid CDN downloads: zero. Actual install/upgrade was not triggered on the user's machine.

Message `geod-agent-release-034` is published for Agent 0.2.0–0.2.13, with an update action. It is excluded for 0.2.14 and classic GeoD. A native client returned this announcement: **True**. This is not a claim that every account/device read the message.

Gateway scope: only activity-store, events-store and the advertised download diagnostics capabilities were patched from the pinned production base. Thirty-six unrelated production files were verified unchanged. Database/credit records and secret configuration remained intact; health and SQLite checks passed. No model/quota/ledger settings were changed.

Backups:
- Gateway: `/srv/laogao/backups/geod-agent-download-diagnostics-20261028-r1`
- Website/update origin: `/srv/laogao/backups/geod-agent-034-20261028`
- Announcement: `/srv/laogao/backups/geod-agent-release-034-notice-20261028-075354/agent-model-before.sqlite`

Not verified and not advertised as delivered: global full downloads, flip outputs, every numeric provider, or full reproduction/delivery of the two original customer tasks. Missing customer telemetry remains unknown.

Machine-readable final receipt: `artifacts/release-034-20261028/release-complete.json`.
