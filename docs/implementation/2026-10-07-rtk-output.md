# Optional RTK command output component

## Implemented

- Optional Windows x64 RTK 0.40.0 component under Skills and connectors → Skills → Optional components. Install, enable, disable, repair, local ZIP, progress and cancel controls. Returning to the page during installation recovers the active request. Enabled state is owned by the authenticated account and survives restart.
- The desktop installer contains the adapter/catalog/license only. The official release archive is 3,884,282 bytes; the executable is 8,754,176 bytes. Archive, extracted executable and license are pinned by SHA-256 in `vendor/rtk-runtime.json`. Download uses GeoD's current network/proxy settings. Python stdlib extracts only the exact pinned executable into a verified staging folder. No new interpreter, Java, OCR or GIS dependency is added.
- Original commands execute through the existing Core/companion paths. RTK receives captured stdout on stdin with an explicit known `pipe --filter` argument. It does not execute the original command or change its argv, permissions, confirmations, plan hash or exit code.
- Before model requests, supported successful native `exec_command`/completed `write_stdin` and background command results (direct or discovered MCP) are compacted. Native history, UI and background ledger retain their original captured results and existing truncation limits. Background AI tool excerpts are currently capped at 12,000 characters by the existing executor; RTK marks summaries of those excerpts, not a promise of unlimited logs.
- Supported filters include Git status/diff/log, rg/grep, fd, Cargo/pytest/Go tests, Go builds, tsc, mypy, Ruff and Prettier. Compound/ambiguous shell commands, arbitrary scripts, JSON/NDJSON, failures, running processes, stderr and unsupported outputs stay unchanged. Warning/error lines omitted by an upstream successful filter are appended. Unavailable/disabled/tampered components, timeouts, empty or larger summaries fall back to raw captured output.
- The helper has a 1 MB input/output bound and a 1.5 second per-filter deadline. Runs with a verified binary in an account-owned isolated profile, with no provider credentials or project-local RTK config. Does not run `rtk init`, rewrite the user's AGENTS.md, install global hooks or initialize RTK telemetry.
- Provider reasoning/signatures, history item/call identifiers and actual billing receipts are preserved. RTK reduces selected command input; model-generated reasoning and arbitrary GIS coordinate payloads are handled separately. Text reduction figures below are not measured Token or fee reductions.

## Evidence

- Frontend production build and desktop debug build passed. Three native RTK tests cover pinned file validation, persistent account scoping and explicit cancellation.
- Six RTK helper tests passed, including real pinned executable, diagnostic preservation, disabled/invalid fallback, JSON/NDJSON preservation, shell/session and background records, and no command evaluation. Related bulk-data and host contract regressions passed (15 passed, one existing engine test skipped without its environment flag).
- Real pinned Core shell + real RTK + fixture provider: original 33,353 characters, model result 7,030 characters (78.9% text reduction). Original native history remained raw; original command ran once; exit code remained zero.
- Real standalone companion command + real background/scheduled Core turn + fixture provider: 22,926 → 5,457 characters (76.2% text reduction); original saved record, argv, stderr and exit code preserved.
- Actual native desktop online install completed through the UI, including download/checksum/extraction progress. Invalid ZIP rejected before installation. Enable/disable verified. Restart verification uses the installed binary and actual account settings.
- Light/dark UI checks at 900, 390 and 300 pixels passed, including install progress, page remount, cancellation, error/retry and contained actions. Screenshots visually inspected. Evidence in `artifacts/rtk-20261007/`.
- All model tests use deterministic local fixtures: zero paid model requests and zero user data downloads. The actual app is a local development build; no release or production deployment is claimed.

## Main source

`src-tauri/src/rtk_runtime.rs`, `src-tauri/src/rtk_extract.py`, `src-tauri/rtk-output.mjs`, `src-tauri/codex-host.mjs`, `src-tauri/src/codex_runtime.rs`, `src/rtk-output-component.tsx`.

Upstream release and exact source: https://github.com/rtk-ai/rtk/tree/v0.40.0. The tagged LICENSE is Apache-2.0; the complete file is retained and installed alongside the executable.
