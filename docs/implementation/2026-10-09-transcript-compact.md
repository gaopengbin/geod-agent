# Compact conversation work and results

## Changes

- Work records without a run ID join the current answer's work group. Continuation IDs are tracked as aliases so active status stays visible. A new user message or final reply separates unassociated work; an explicit existing run ID still supports user steering in that run.
- Answered, cancelled and resolved question history is nested in the originating work group once its answer is complete. Completion closes a reviewed question once. Users can reopen the work group and question history afterwards.
- Pending questions remain separate, including after a final reply or an interrupted turn. Their saved drafts and answer/continuation behavior are preserved.
- Background job records remain in persisted conversation data for tracking and recovery but no longer render individual download rows in the transcript. The existing task summary card opens the right task panel with task details, approvals and results.
- No download, approval, credential or storage protocol was changed.

## Verification

- 15 unit tests passed across work grouping and plan presentation, including restored events, mixed run IDs, steering, question history and permanent task ownership/anchors.
- TypeScript and production frontend build passed.
- `test/transcript-compact-ui.mjs`: real components with isolated fixture data. In light/dark themes, 120 operations form one work group, three completed questions are accessible inside it, 13 jobs produce one summary card and no individual job rows. The summary opens the real task panel. Waiting questions can be answered, completion folds the history, and restored views fit 380px width.
- Existing question persistence/draft/submit/cancel checks and transcript following/reader position checks passed.
- Visually inspected completed dark view and light results panel screenshots.
- Evidence: `artifacts/transcript-compact-20261009/acceptance.json` and screenshots in the same directory.
- Development server is running and the native development preview remains visible. No public installer or release was published; UI checks used no real model calls or downloads.
