# GeoD Agent Codex conversation presentation

## Scope

The existing desktop ChatTranscript now uses the Codex conversation organization selected by the user. This is a local frontend change wired to the existing Codex/native event stream. Provider routing, execution policies and billing behavior are outside this change.

## Presentation

- Commentary stays in the reading column. The old execution timeline and its repeated leading heading are replaced by compact activity rows.
- Adjacent exploration operations coalesce from native `commandActions`, MCP `readOnlyHint`, or known GeoD inspection tool contracts. Arbitrary command text does not determine read-only status. Adjacent other tools share a disclosure; commands and commentary keep their event boundaries.
- Active reasoning has one current activity row. Only the service-provided visible summary is displayed; empty reasoning events do not create additional placeholders.
- A completed turn defaults to a compact completion disclosure. Explicitly inspected activity and summary details remain open. Final replies stay outside the disclosure.
- Completion/interruption/failure labels come from the final reply or outcome record. An idle flag does not establish success. No whole-turn elapsed time is invented.
- Native command events retain their real exit code, duration and command actions. Expanded command output uses the existing ScrollArea and copy control.
- Reader scrolling and disclosure inspection suspend following, including across completion. “回到最新” explicitly resumes following. Nested reasoning and command logs scroll separately.
- Existing question history, source/configuration actions, task summary entry and the Token icon to the right of Copy remain available.

## Validation

- Frontend TypeScript check and production build passed.
- 39 relevant Node regression tests passed: activity grouping and replay deduplication, native item reduction, final reply promotion/recovery, question records and token accounting.
- Browser interactions used the current source components through the local Vite server at port 1426. New replay fixture: `/test/codex-conversation-harness.html`. This fixture labels itself as a local UI replay and calls no models or native tools.
- Actual browser checks: initial single thinking row; completion auto collapse; final reply outside the disclosure; explicit summary/command expansion retained on completion; command output/exit code; keyboard access to usage tooltip; stopped/error/pending question states; question submission; light/dark themes; 390 × 844 viewport without horizontal overflow; emulated reduced-motion with computed animation `none` (then restored).
- Long reply streaming increased one existing final message while scrollTop stayed at 0. Completion preserved that reading position; “回到最新” reached distance 0 from the bottom.
- Existing 13-task fixture retained one summary and no individual download rows, reopened confirmed EPSG:4326 question history, and opened the actual task-panel component.
- Computed light-theme contrast: body 16.10:1; activity text 7.00:1. The running text shimmer uses the existing text colors, without reducing opacity; reduced-motion disables its animation.

Evidence is saved under `artifacts/codex-conversation-20261013/`, including `ui-report.json`, completed light, command dark, and narrow dark screenshots. The fixture's sample command durations and usage values are synthetic protocol inputs, not real download/model measurements.

The replay fixture now preserves its React root across Vite hot updates. Three earlier root warnings from editing the fixture remain in the browser log history; the verified clean reload introduced no console errors.

This validation establishes component presentation and interactions, not a new native-window/model end-to-end acceptance or release. Earlier UI scripts that require the previous pinned status outside the transcript describe the superseded layout; the current replay/report is the Codex-style acceptance evidence.
