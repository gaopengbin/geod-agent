# Acquisition diagnostics and reporting acceptance

Scope: GeoD Agent 0.2.15 and a versioned diagnostic contract consumed by legacy GeoDownloader 3.6.21. No CLI/MCP changes.

## Confirmed gaps

- Legacy attached the collector only to Tianditu tasks; the downloader independently filtered it to Tianditu too. Both attachment points now observe every provider, while credential selection and token failover remain Tianditu-only.
- Agent defaulted to reporting disabled without a first-use choice. This is an observability gap, not proof that the reporting customer declined consent. Existing basic consent cannot authorize the expanded diagnostic scope.
- Background collection errors lacked visible health; exact native event sequence and durable cursor reconciliation are now used. Tests cover failed-attempt isolation, fast terminal tasks without UI polling, no historical replay, consent separation and unknown duration.

## Data contract

Version 1 records fixed provider/endpoint classes, role, redacted service host, template fingerprint and whitelisted style/binding options. Only observed responses receive HTTP status; cached success does not invent HTTP 200. Storage records group actual volumes and retain roles, required/available bytes, budget type and measurement timestamp. Missing values remain null. Full URLs, credentials, filenames, paths and coordinates are rejected at ingestion.

## Verification

- Agent core/engine/native and both frontends passed their relevant regression suites.
- Linux receiver tests passed against a copy of the production source with only event storage/capability changes. Existing routing, model limits and billing modules were retained.
- Internal account normal login and OAuth PKCE passed. Its credentials used an isolated loopback vault namespace, never the owner's entry.
- Agent: real Amap satellite and annotation produced a verified GeoTIFF bundle. Default-off reporting sent nothing. After opt-in, reopening the task database before collection still delivered success and controlled overlay-403 terminal diagnostics; the production database confirmed receipt.
- Legacy: real native satellite/annotation tile download and merge passed. A controlled overlay 403 retained phase, layer index and status. The actual lifecycle producer serialized 4 events and the online receiver acknowledged all 4.
- Administrative account/installation exclusion was created before QA ingestion. Production readback confirmed the internal account was excluded from the Agent report and the anonymous installation from the legacy dashboard.

Evidence is retained locally in artifacts/telemetry-20261029, including online-qa-verification.json. QA events are not real external-user activity.

## Limits

This does not establish the exact cause of the customer's historical 403 or disk warning. Those older events did not carry sufficient detail. No customer external E drive, 40,200-tile task, or real low-space condition was available here. Cross-volume and low-space logic use regression fixtures; controlled HTTP 403 is identified as simulated. Opted-out activity remains unobserved.

## Operations

Receivers: immutable acquisition-diagnostics-20261029 releases, backed up under /srv/laogao/backups/geod-diagnostics-20261029. SQLite migrations are additive. Identity QA provisioning used the deployed source's accountTransaction lock with a pre-write backup; other accounts were hash-checked unchanged. Online deployment checked the actual process path and schema, beyond health responses. Rollback uses the retained previous service directories and private PM2 configuration. No Credits or model route change.
