# Reasoning-only output must not silently complete a turn

## Observed failure

Native receipt `c9da4c8d-df69-46cf-bc12-6aa72533efc3` was marked completed, but its last model generation (`56eb6852-9093-4c69-b148-14b56b5f3211`) contained no reply or tool calls. It returned 8,192 output tokens and only reasoning, ending partway through a coordinate list. This matches the hosted gateway's default output budget. The previous stream collector discarded `finish_reason`, so the historical provider's exact stopping reason is not recoverable from that stored result.

The verified defect is that the host emitted a normal completed response for reasoning-only output. The frontend then left the unfinished reasoning marked attention without a durable visible turn result. Refreshing lost the transient error state, leaving the partial content with no explanation.

## Fix

- Preserve the supplier's `finish_reason` through the hosted stream and Codex result contract. Known token usage remains settled in the ledger; this is distinct from successful completion of a user task.
- Reject explicit output-limit/content-filter results and responses without any reply or tool action before emitting completed output or executable tool-call frames. These errors are terminal for the current model round; they do not automatically retry the paid request.
- Keep a durable, separate turn outcome for errors and interruptions, outside the folded execution records. Offer explicit continuation only for the current task, when no active turn or unresolved request blocks it.
- Recover legacy reasoning-only turns only after matching authoritative native turn and generation records in the same conversation. Original questions, accepted answers, reasoning and tool records remain unchanged. Recovery does not invent a model answer, alter monetary usage, or resume work.
- On explicit continuation, reuse the existing task authorization and confirmed answers. Add a runtime instruction to process long coordinate arrays with actual tools/files rather than enumerate them in reasoning. This instruction guides model behavior; the completion guard enforces the actual outcome boundary.

## Verified

- Hosted gateway integration with a mock upstream preserves both tool completion and `length`, records known usage, and re-reads the same generation without another upstream call.
- Real pinned Codex runtime, with a mock provider response, stops after one output-limited reasoning response, reports failure, and executes no tool. Existing supplier-route terminal rejection and native Responses settlement checks pass.
- 16 focused work-history, onboarding and turn-outcome unit tests pass.
- Light/dark and 360px UI tests cover durable outcomes, preserved answer history, no automatic continuation, a single explicit continuation, and completed history.
- Frontend production build and diff checks pass.
- The real idle development window now displays the incomplete outcome and enabled continuation button. Original transcript hashes and seven model generation records are unchanged; the outcome survives another refresh. No model call or imagery download was triggered by acceptance.
- The local development gateway was restarted with its ledger preserved and health readback confirmed. Debug native runtime source hashing picks up the updated host script for the next real turn. No production deployment or release was performed.

Evidence: `artifacts/turn-outcome-20261007/ui-report.json`, `native-report.json`, `native-incomplete.png` and the light/dark narrow screenshots.
