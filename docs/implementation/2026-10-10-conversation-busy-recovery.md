# Native conversation recovery

## Observed failure

The live UI was idle while sends returned `CODEX_BUSY`. Its saved-generation reconciliation path only checked the model generation and released frontend pending state, then claimed the native execution had stopped. It did not check the native conversation lease. Busy rejections were also recorded as failed turns with a Continue action, leading to repeated rejected sends.

Readback found the original recorded run failed and the three rejected run IDs had no execution receipt. A later scoped interrupt returned `CODEX_RUN_NOT_FOUND`: that original run had already ended by the time of inspection. No model task was retried during repair.

## Changes

- Added owner-scoped native conversation status and stop commands. Status reads the execution lease and active runtime, independently of the billing receipt.
- Stopping waits for the lease to release; it cannot report success merely because an interrupt command was accepted.
- The native event receiver checks explicitly requested cancellation every 100 ms. If Core does not acknowledge interruption within three seconds, the owned conversation host is terminated and the lease released. Ordinary model waits, human input waits, companion jobs and completed downloads are unaffected.
- Frontend connection timeouts retain busy state while cancellation finishes, with a bounded stop wait. A new send from an idle client checks for a surviving native lease first.
- Saved-generation reconciliation now requires actual native recovery before claiming the old execution stopped. Older binaries receive a restart hint rather than that unsupported claim.
- Busy rejections do not create failed-turn/Continue cards. Existing such cards are hidden while original human messages and genuine execution failures remain intact.

## Validation and live readback

- 16 JavaScript tests passed for cancellation wait/bounds, conversation preflight, old-binary compatibility, busy classification, and existing outcome behavior.
- Two native tests passed for account/conversation-scoped lease status and explicit-only cancellation deadlines.
- Light and dark real-component UI fixtures verify rejected requests have no failure cards or retry buttons, preserve human messages, and retain genuine model-output failures. No paid model calls.
- Frontend production build and native preview build passed.
- Normal guarded quit succeeded; the rebuilt development preview was opened without force killing or stopping the companion separately.
- Live native readback: `conversationExecution:true`, `contextSettings:true`, conversation `busy:false`, no active run, background running, all 13 jobs still completed, effective default context 128,000 tokens with 90% compaction preference.
- Evidence: `artifacts/codex-recovery-20261010/acceptance.json`, and `artifacts/desktop-tray-20261009/conversation-recovery-acceptance.json` / `conversation-recovered.png`.

This updates the development preview only. It does not publish a new installer or website release, and no live model turn was charged for validation.
