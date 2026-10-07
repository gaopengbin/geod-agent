# MCP credential dialogs only open on request

## Report and cause

The desktop repeatedly opened the Amap credential dialog while processing an unrelated route task. Native connector metadata confirmed that Amap already had a saved `key` and was enabled.

Two problems caused the recurrence:

- `ExtensionReview` initialized its open state from `requiresKey && busy`, so remounting an old card during any active turn opened the credential form.
- Connector reconciliation changed React display state without updating `displayRef`, which is used for subsequent stream events and persisted transcripts. A later event could restore the obsolete setup card.

## Changes

- Credential forms start closed and open only through the card's explicit configuration button. The pending card remains available in conversation history.
- Reconciliation and successful configuration update both the current transcript reference and the visible state before persisting.
- Reconciliation also runs when the MCP proposal set changes; ordinary text deltas do not trigger repeated connector reads.
- History restoration does not regenerate a setup request from diagnostic details already reconciled as successful.

No connector is enabled, removed, contacted, or given new credentials by these changes.

## Verification

- The new transcript UI regression first failed against the old code: the historical Amap setup card opened a dialog with an unrelated task busy.
- The same regression now passes for Amap and Mapbox, in light and dark themes: busy history, explicit opening, dismissal, another task, session remount, page reload, reopening, and saved/enabled state reconciliation.
- 13 scoped onboarding and Mapbox unit tests pass, including history restoration after successful reconciliation.
- The frontend production build and `git diff --check` pass.
- Evidence: `artifacts/mcp-dialog-trigger-20261007/ui-report.json` and provider/theme screenshots.

The running development window was still executing a user turn during verification. Its previously loaded module did not receive hot updates; it was not restarted or reloaded during that work. Native metadata was inspected without accessing credential values. The fix is ready for the next safe refresh of the development window.
