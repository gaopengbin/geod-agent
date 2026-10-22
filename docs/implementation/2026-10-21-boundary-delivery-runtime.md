# Boundary delivery and unusable model response repair

## Runtime changes

- Saved conversation boundaries can be exported by `data_download_plan` with `kind=boundary`, `sourceBoundaryId`, `outputFormats` and optional `dissolve`. The native host resolves and freezes the real conversation-owned geometry. Caller-supplied snapshots are replaced. No service URL or system Python/Conda search is needed.
- Online feature snapshots also support polygon union. The managed GIS worker preserves holes and islands, declares the attribute policy, writes to an isolated staging directory, reopens GeoPackage, checks CRS/count/geometries/attributes, and commits verified files through the existing approval and background-task ledger.
- Tool discovery ranks native export capabilities. Connector discovery also returns relevant native contracts and the direct saved-geometry export route. Repeated catalog pages expose activation and fingerprint evidence instead of suggesting that rewording the query discovers new providers.
- Task identity excludes display titles and transient call IDs. Equivalent requests are compared after deserialization, preserving old defaults. Pending, running, interrupted and completed tasks are reused within the same owner/conversation/physical workspace; completed files must still pass manifest/hash verification. Discarded or hidden tasks are not silently resurrected. Changed requests still require their own plan.
- Native plan lookup runs again rather than returning a permanently cached plan receipt after discard/cleanup. A failed remote endpoint no longer disables unrelated `data_input_read` sources.
- New optional export fields are omitted when unused, preserving historic online source fingerprints and completed-task inspection.

## Gateway and historical holds

Unusable protocol responses (invalid tool contracts, malformed streams or missing trusted usage) now carry safe stage/code/request-ID/returned-tool diagnostics. Provider text, prompts and credentials are not persisted. No valid tool proposal is dispatched; the failed generation releases the customer's reservation. Uncertain network/provider outcomes remain separate and must not be guessed successful or uncharged at the provider.

`waive-unusable-results.mjs` is an explicit operator repair for historic pending protocol failures. It validates exact account/generation IDs, refuses charged or usable generations, backs up both databases without overwriting earlier backups, records the original error and **unknown provider usage**, and releases customer holds idempotently. It does not reclassify unknown upstream usage as zero, issue new Credits, or interrupt unrelated streaming requests.

Three reviewed historical holds were released under the user's current authorization. The production gateway service was not replaced by this development task; the general gateway patch remains in source for the next authorized deployment.

## Evidence

Evidence is under `artifacts/boundary-export-20261021/` (private operational artifacts, not source-controlled user records).

- Native real-model task: official U.S. Census county retrieval → saved ranges → union → native export → completed task → GeoPackage readback.
- Independent verification compares the actual GeoPackage to the union of all five retrieved county geometries and checks one valid MultiPolygon, EPSG:4326 and SHA-256.
- Repeated planning with a fresh execution ID and changed title reuses the completed task without another download or confirmation.
- Synthetic geometry regression separately checks shared edges, holes and detached islands.
- A first real delivery succeeded with 9 model requests and zero clarification questions. Its optional map preview timed out in the detached acceptance session; that is not evidence of a failed file delivery or a visually verified map preview.
- Sponsored Luna returned a balance failure during initial testing. Subsequent real testing uses the existing hosted DeepSeek provider through a temporary loopback-only SSH transport; provider credentials stay on the server, owner/test activity is excluded, and no real-user wallet is topped up.
- All 116 regular gateway tests pass; targeted runtime/context/workflow tests pass (61, with 4 opt-in Core integration checks skipped); native ledger and old-fingerprint compatibility checks pass. Optional manual live scripts are not part of the regular unit-test gate.

No fixed model-turn cutoff was added. Progress, current contracts, native evidence and unchanged failure conditions drive recovery.

## Final acceptance

The final native DeepSeek run completed in 26.7 seconds with 6 model requests, no clarification prompts, one plan, one execution and no tool errors. No map preview was requested in this file-delivery run. GeoPackage contains one valid EPSG:4326 MultiPolygon equal to the official five-county union. Fresh call IDs and a different title reuse the same completed task, including confirmEach mode without a new approval. County short and official names were separately queried live and agree. 195 native tests pass (22 optional ignored), 61 runtime tests pass (4 optional skipped), and 116 regular gateway tests pass. Type checking passes. See acceptance-complete.json for exact tokens and file hash. The temporary QA provider channel, credential and SSH transport were removed; the development desktop stays running.
