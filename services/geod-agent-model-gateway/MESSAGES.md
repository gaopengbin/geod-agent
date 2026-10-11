# Classic GeoD public announcements (3.6.11)

Classic GeoD remains free and open source. Its notification center has no login, account-targeted delivery, remote read receipts or Credits integration.

Announcements accept product geod-agent (the old-data default), geod, or all. GeoD publications reject audienceAccountId. The anonymous GET /api/agent/messages/public?product=geod&clientVersion=3.6.11 endpoint returns published, public geod/all notices matching date and version filters, with accountId null. It never calls identity, model or welcome-credit logic. Read and reminder state stay on the device per message revision.

GeoD Agent retains its existing authenticated inbox and account targeting. Public classic GeoD clients cannot choose recipients, write receipts or publish notices. Deploy the public gateway compatibility route before publishing the desktop installer; no identity service change is needed.


# Legacy GeoD desktop compatibility (3.6.11)

Announcements accept `product: "geod-agent" | "geod" | "all"`. Existing publications without this field continue targeting GeoD Agent. For GeoD-only publication, explicitly set `product: "geod"`; cross-product notices must explicitly use `all`. Do not broadcast QA messages.

Legacy desktop inbox requests include `product=geod` and their actual `clientVersion`; read receipts include `product: "geod"` and the authenticated `accountId`. They require identity client `geod-desktop` with `geod:notifications` scope. GeoD Agent retains its existing client/scope. Notification-only tokens cannot access model or wallet routes, and inbox/read calls skip welcome Credits issuance. Same-revision `all` notices share account read receipts across products.

Anonymous legacy desktop requests use `GET /api/agent/messages/public?product=geod&clientVersion=3.6.11`. This read-only route excludes all account-targeted notices, drafts, expired and version-incompatible entries; it returns `accountId: null` and no server read receipts. It never calls identity, model or welcome-credit logic. Anonymous receipts stay on the device, keyed by message ID and revision. Public reads cannot choose an account or publish/write notices.

Before publishing a legacy client installer, deploy the matching identity-client registration and gateway compatibility patch, then verify authorization, audience targeting and receipts. No database schema migration is required for the optional product field.

