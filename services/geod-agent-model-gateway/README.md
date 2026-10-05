# GeoD Agent model gateway

Run `npm test` for local verification and `npm start` with the configured GeoD
identity service and upstream model environment.

## Download telemetry

`POST /api/agent/events` accepts opt-in desktop download outcomes using the same
GeoD Bearer authentication. Include `events-store.mjs` when packaging this service.
Data lives in `agent_events`, separate from model usage and WeChat identities.
See [the implementation and verification notes](../../docs/implementation/2026-10-02-geod-telemetry-improvements.md).

## Sponsored model channels

`GEOD_AGENT_SPONSORS_JSON` configures operator-owned providers. Keys are read
from each provider's `apiKeyEnv` on the server. The authenticated
`GET /api/agent/sponsors` returns public branding, allowed models and usage;
clients cannot select a provider endpoint or supply its key.

Sponsored Chat Completions, Responses, Claude Messages and Gemini requests use a captured provider/model/revision and
an independent ledger. `observe` records usage without enforcing a budget;
`enforced` requires explicit per-user and shared token limits.
The default `budgetPeriod: "lifetime"` keeps cumulative accounting and existing
configuration revisions. Optional `budgetPeriod: "month"` uses UTC calendar
months and publishes the period bounds; requests belong to their reservation
month even if settlement is later. No ledger history is deleted at renewal.
Unresolved prior reservations remain visible, and configuration revision changes
do not replenish the current period. Deploy compatible clients before enabling
monthly campaigns. This is a campaign token allocation, not the provider's cash balance.
Unknown, disabled, changed or insufficient-budget routes fail without changing
the funding source. Optional `startsAt` / `endsAt` are explicit zoned activity dates;
they do not reset accumulated usage. Declared image models accept native image attachments.
Existing text/chat provider revisions remain compatible when new options are absent.
Sponsored and personal-key records do not consume the
GeoD wallet in the optional billing candidate.

Include `sponsor-budget.mjs` together with `sponsors.mjs` and `ledger.mjs` when
packaging this service. Client month metadata requires a compatible desktop;
legacy gateways without the optional catalogue are treated as having no sponsors.

See [configuration, actual model/restart acceptance and release boundaries](../../docs/implementation/2026-10-04-sponsored-channels.md).
See [native protocols, real image/tool calls and activity dates](../../docs/implementation/2026-10-04-sponsored-native-protocols.md).
See [calendar budgets, real foreground/headless calls and restart evidence](../../docs/implementation/2026-10-04-sponsored-months.md).

## Optional payment candidate

### Welcome Credits

The normal enforced gateway now starts each new Agent wallet with **20,000
Credits**, equivalent to ¥20 of GeoD AI billing balance. The server grants it
automatically after verifying the GeoD OAuth identity. No claim button or
client-supplied account ID/amount is accepted. Existing GeoD identities can try
Agent when first activating an Agent wallet; wallets with earlier credit lots
do not receive another new-user gift.

The grant and its wallet lot commit in one SQLite transaction, with a unique
`(account, kind)` key. Device changes, simultaneous logins, service restarts,
policy version changes and repeated balance reads cannot replenish the gift.
Hosted model requests reserve and settle this balance from trusted provider
usage. Uncertain responses retain their reservation. Personal keys and
sponsored requests retain their independent funding. Gifts are recorded
separately from paid orders and are consumed before paid credit.

`GEOD_AGENT_WELCOME_CREDITS` defaults to `20000` for a normal enforced gateway
without an existing payment configuration. Set it to `0` to stop new gifts;
previously created credit-only wallets still open and can spend their existing
balance. An explicit unlimited test configuration retains unlimited testing
and grants nothing. A paid deployment opts in by specifying a positive gift
amount together with its existing enforced payment configuration.

The default wallet file is `<GEOD_AGENT_DB_PATH>-credits.sqlite`; a payment
deployment uses its reviewed payment `dbPath`. Retain and back up this database
to preserve grants and consumption history. `GEOD_AGENT_WELCOME_POLICY_ID`
defaults to `geod-agent-welcome-v1`; a version cannot change its original amount,
and a new version still cannot grant twice to the same account.

Merchant setup and checkout remain optional and disabled on credit-only hosts.
The authenticated wallet returns the actual grant receipt and remaining amount.
The desktop displays these receipts only when the server returned them.

This is included in the local implementation and requires deployment of the
matching gateway before the existing hosted service can issue gifts.

The desktop account menu opens **Balance & subscription**. The shared dialog
contains plan preview, payment history and compact AI usage receipts. Payments
are disabled on the ordinary test gateway; testing remains unlimited. Older
gateways without the optional routes retain this honest disabled state.

`GEOD_AGENT_PAYMENT_CONFIG` is an optional JSON file owned by the server operator.
An empty variable starts no cash-payment provider request. The welcome wallet
can still be active independently. The example file
has false approvals, zero limits and placeholders and intentionally cannot run.
Do not put merchant keys in the desktop, this repository or logs. Relative paths
are resolved against the server process working directory.

External configuration requires all of the following to match the reviewed
candidate: `catalogueApproved: true`, `approvedPricingVersion` and
`approvedCatalogueSha256`. Calculate the last value from
`paymentCatalogueDigest(products)` in `payment-host-candidate.mjs`; omit the
argument for the draft default catalogue. A new price or product catalogue must
be reviewed again. These configuration fields do not grant deployment or money
authorization by themselves.

`observe` records payments without charging AI requests; `enforced` reserves
server-calculated maximum fees before contacting the hosted model and settles
only trusted gateway usage. The priced model is currently DeepSeek Flash. Keys
and sponsored channels use their independent funding. The payment and model
SQLite files must be distinct. Each request captures its original rate snapshot;
legacy reservations without one enter review rather than adopting current rates.

The authenticated wallet returns available credit, request reservations, frozen
refund credit, payment records and the latest 100 usage receipts with total
counts. Receipts contain exact amounts, token counts and original retail price
version, without prompts or upstream credentials. Checkout/return-page visits
never credit money. Ambiguous payment/refund results reconcile the original ID.

Keep `payment-host-candidate.mjs`, `payment-ledger-candidate.mjs`,
`payment-http-candidate.mjs`, `alipay-payment-candidate.mjs`,
`pricing-candidate.mjs`, `welcome-credit-policy.mjs` and the locked SDK dependencies with `server.mjs` when
preparing a candidate package. This wiring is still a locally verified candidate:
merchant coverage, shared merchant budgets, final policy, external sandbox and
authorized real-money acceptance remain release gates.

See [native UI, protocol and restart acceptance](../../docs/implementation/2026-10-04-payment-service-candidate.md).

### Complete account records

Authenticated `GET /v1/payments/history/{usage,reservations,orders,refunds}`
returns account-owned history beyond the wallet's recent 100 rows. Each kind
also supports `/export.csv` for the entire selected date range. The server
advertises `creditHistoryEnabled` and `paymentHistoryEnabled` separately;
credit-only hosts expose empty cash history while keeping cash mutations off.

Queries accept inclusive `from`, exclusive `to`, `limit` (1–200) and a signed
`cursor`. CSV accepts dates only. Cursors bind the authenticated account, kind
and dates, survive service restart and exclude later inserts. Row status is
current when read; CSV holds one independent SQLite WAL read snapshot.
Client-supplied account identifiers and mutable status filters are rejected.

Exports include exact integer amounts and decimal CNY, UTC dates and original
price metadata. They exclude provider identifiers, credentials and prompts.
Desktop writes verify bytes and SHA-256 before replacing a selected file.
Keep `credit-history.mjs` in the frozen service package. These read-only routes
do not enable checkout or replace merchant cash reconciliation.

See [order/refund desktop and native acceptance](../../docs/implementation/2026-10-05-payment-history.md).
