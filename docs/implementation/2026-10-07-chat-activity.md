# Visible activity outside folded execution records

## Change

The transcript's previous loading row was suppressed whenever the active turn had a work-record group, a streaming final answer, or a final tool row marked running. That row also lived inside the scrolling transcript. Folding execution details or reading long reasoning could leave no visible current activity near the input.

`ChatTranscript` now renders one activity row outside the transcript scroller, directly above the composer. It follows current execution state and remains visible while the work history is folded or scrolled. Its text uses real stage updates, such as model wait, reasoning, tool execution, user input wait, and response generation. It does not display a made-up percentage.

An active Codex run ID also keeps the indicator active across the busy-state transition. Historic `running` or `streaming` flags alone never create an activity indicator. Completion or stopping removes it. An accepted answer immediately updates the status to “正在继续处理…” while the original request resumes.

The compact status uses existing theme colors and the shared `MessageTyping` component, including its reduced-motion behavior. It has a polite accessible status announcement and Chinese/English labels.

## Verification

- The new UI regression failed against the previous code because a busy turn had no status outside the scrollable work history.
- Browser regression passes in light/dark themes and at 360px width: folded records, long reasoning and scrolling, user wait, tool execution, final streaming, a new turn without work entries yet, active run ID, completion, and stopped history with an old running row.
- 17 related work-record, Codex item lifecycle and question-history tests pass.
- Frontend production build and whitespace/diff checks pass.
- The idle development window was refreshed only after verifying no current user turn, downloads, commands, or scheduled AI tasks. Its actual mounted `ChatTranscript` contains the new indicator. The current conversation and Amap/Mapbox enabled state and credential metadata stayed the same, and old credential dialogs did not reopen. No model call or download was started for verification.

Evidence: `artifacts/chat-activity-20261007/ui-report.json`, `native-report.json`, and collapsed/long-reasoning/narrow screenshots. Active states use an isolated UI fixture; the native check validates loading the updated component and the idle state, rather than claiming an additional real model download test.
