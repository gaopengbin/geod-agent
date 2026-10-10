# Model cost audit and request protection

## Verified account billing

Read-only production account ledger audit at Beijing time 2026-10-10 01:15:49:

- Welcome credit: 20,000 Credits; settled deductions: 19,419.62816; remaining: 580.37184.
- 182 charged model generations in the complete account ledger. No duplicate generation charge IDs or mismatches against each charge's original stored rate snapshot were found. No active credit reservation remained.
- Charged usage: 8,891,568 input tokens, including 4,993,152 cached tokens; 214,157 output tokens. The larger account usage indicator also covers model usage not present in this charge ledger; it must not be equated directly to charged tokens.
- One comment, “看起来好像没有明显偏移呢”, triggered 31 native model requests; 30 were charged, costing 8,749.5472 Credits. They consumed 1,881,802 input tokens with only 3,840 cached tokens, plus 77,337 output tokens. The three later busy rejections had no receipts or charges; the subsequent insufficient-credit rejection was also uncharged.
- “加载混合地图”: five charged requests / 2,080.7432 Credits. “下载故宫的历史影像”: 42 charged requests / 2,121.51008 Credits with far higher cache reuse. Message count alone does not measure actual model requests or cost.
- Complete scoped audit: `artifacts/desktop-tray-20261009/credit-audit-complete.json`. The native wallet only exposes recent charges because the current production service lacks the full-history endpoint; the complete audit therefore used read-only SQLite, not that partial page.

## Product defects addressed locally

1. The model initiated a long verification experiment from a casual observation. Updated runtime instructions require a short conversational response for comments and acknowledgements unless the human explicitly requests an action/check; a correction saying “I was only commenting” stops further investigation.
2. Fresh task state was appended to the system instruction prefix with a changing `readAt` timestamp. This changes the prefix before long history and defeats reuse of that history. The timestamp remains available for local audit but is excluded from the prompt. Authoritative task facts are now a trailing developer input after the intact stable history. State changes still refresh normally. This repairs the structural cause; future provider cache hit ratios have not been measured with paid calls.
3. No native model-request cap prevented runaway loops. Added an account-scoped limit, default 12 requests per user turn, configurable 1–100 under Model & Channels → Context settings. The native receiver rejects the next model request before dispatch/reservation; tool follow-ups count too. The UI records a clear incomplete outcome and releases pending generation state so explicitly continuing remains possible.

This is a request-count guard, not a per-turn currency cap. A large context can still cost more per request, and actual savings depend on provider caching. Context capacity itself was not reduced. No production prices, credit lots or other billing records were changed, and no compensation was issued by this audit.

## Validation

- Five native live-task snapshot tests passed, including unchanged timestamps producing identical prompts and changed task states preserving the original tool-call/history prefix.
- Two native preferences tests passed, covering old preference migration to the 12-request default, account isolation, persistence and invalid limits.
- Three native execution tests passed, including rejecting request 13 before model dispatch.
- Real light/dark settings components passed save/reload of an eight-request limit, rejection of 101, reset to 12, and a scrollable 380px dialog.
- Existing host, liveness and turn-outcome tests: 16 passed; one optional paid real-Codex integration test skipped. Frontend and native preview builds passed.
- The development preview was updated by normal guarded exit/reopen; production billing remains read-only. No paid model calls were made to measure savings.
