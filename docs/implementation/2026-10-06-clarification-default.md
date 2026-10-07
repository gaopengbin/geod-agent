# Default to clarifying user intent

- All Agent tasks now follow the same policy: inspect discoverable facts, ask the user about missing or ambiguous requirements that affect results, and wait for actual answers before planning/executing. Full Access does not delegate parameter choices.
- Removed legacy defaults that silently selected zoom/format, merge mode or a lower resolution after capacity errors. Previously chosen defaults (uncompressed export, no pyramid) remain recognized.
- Explicit human delegation (do not ask, decide for me, use defaults) permits feasible choices within its scope and requires a brief explanation of assumptions. It never bypasses credentials, capacity or native permissions.
- Hosted gateway and native Codex host use one shared policy; sync-codex-tools embeds it into the standalone native host so it has no runtime import dependency. The development host reloads when its source hash changes on the next turn.
- The frontend historical-period gate recognizes direct opt-out requests, remembers them within the conversation, and supports ask-first revocation. Its recognition is deliberately narrow, excludes quoted examples and conditions, and uses only human display messages rather than source/tool content.
- The generic clarification policy is model-driven; no claim is made that a parser detects every possible natural-language ambiguity or delegation scope.

## Checks

- TypeScript compilation and focused policy/delegation tests.
- Read-only native model probes recorded separately in artifacts/clarification-default-20261006. No user download or release installation is performed by these probes.


### Verified results

- 14 focused tests passed, one optional Codex end-to-end test skipped. TypeScript compilation passed.
- Real hosted model: “下载北京市的影像” queried facts and requested a question card before creating a plan. Explicit delegation requested no questions and selected parameters for plan_imagery. The probe intercepted plan execution; zero download jobs were created.
- Boundary lookups in the isolated probe use the same compact attachment helper as the product; detailed geometry remains native. An earlier probe passed raw geometry to the model and exceeded the legacy request limit, so that failed probe is not counted as product acceptance.
- Shared native-host policy matches the gateway byte-for-byte and is inserted once. Development host source hashing refreshes it on the next native turn; no installer was run.
- Development gateway restart resolves its actual listening PID and runs outside the Codex package filesystem view, preserving the real ledger rather than a redirected AppData copy.
