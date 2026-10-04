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

The desktop account menu opens **Balance & subscription**. The shared dialog
contains plan preview, payment history and compact AI usage receipts. Payments
are disabled on the ordinary test gateway; testing remains unlimited. Older
gateways without the optional routes retain this honest disabled state.

`GEOD_AGENT_PAYMENT_CONFIG` is an optional JSON file owned by the server operator.
An empty variable starts no payment ledger or provider request. The example file
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
`pricing-candidate.mjs` and the locked SDK dependencies with `server.mjs` when
preparing a candidate package. This wiring is still a locally verified candidate:
merchant coverage, shared merchant budgets, final policy, external sandbox and
authorized real-money acceptance remain release gates.

See [native UI, protocol and restart acceptance](../../docs/implementation/2026-10-04-payment-service-candidate.md).
