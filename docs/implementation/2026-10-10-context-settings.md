# Configurable Codex context

## Behavior

- Model & Channels now exposes an account-scoped context token budget and automatic compaction threshold. The context usage popover opens the same settings in a dialog.
- Leaving the budget blank follows the selected channel's declared model capacity. Supported explicit budgets are 16,000–4,000,000 tokens. Compaction accepts 50–95%, defaulting to 90%.
- The engine caps the effective budget at the selected channel's declared capacity and reserves the model output allowance plus 1,024 tokens. The interface shows the declared capacity, effective budget, and effective compaction limit separately.
- Preferences are stored in the native channel SQLite database by account. Validation and asynchronous account checks prevent writing another account's preferences after an account switch.
- Settings apply on the next model request. They do not alter a currently running response or reconstruct context already compacted.
- This applies to the current Codex engine. Legacy character/message compaction remains unchanged. Hosted model capacity is not increased by this setting.

## Validation

- Two Rust tests cover persistent account isolation, invalid-write rejection, budget clamping, output reserve, and automatic capacity.
- Five isolated UI acceptance cases cover save/reload, account isolation, reset/validation, narrow dialog layout, and visible channel-capacity clamping. Fixtures make no paid model calls.
- Codex host and existing legacy context tests: 12 passed, one optional real-Codex integration test skipped.
- Evidence: `artifacts/context-settings-20261010/acceptance.json`, `configured-dark.png`, and `dialog-light-narrow.png`.

## Running preview boundary

The live preview was retained because its guarded quit refused an update restart. An explicit companion stop during the update attempt caused a backend-unavailable message; the companion was restored, and native readback confirmed all 13 jobs remained completed. The stale backend error disappeared after successful refresh.

During the subsequent conversation-busy repair, normal guarded quit succeeded and the updated preview was opened. Live readback confirmed `contextSettings:true`, default preferences (automatic budget, 90% compaction), effective model context 128,000 tokens, and all 13 jobs still completed. A runtime capability check remains in place to show a restart-required message for older binaries instead of invoking unsupported commands. The live window was not force-killed.
