# Classic GeoD public announcements (3.6.11)

Classic GeoD remains free and open source. Its notification center has no login, account-targeted delivery, remote read receipts or Credits integration.

Announcements accept product geod-agent (the old-data default), geod, or all. GeoD publications reject audienceAccountId. The anonymous GET /api/agent/messages/public?product=geod&clientVersion=3.6.11 endpoint returns published, public geod/all notices matching date and version filters, with accountId null. It never calls identity, model or welcome-credit logic. Read and reminder state stay on the device per message revision.

GeoD Agent retains its existing authenticated inbox and account targeting. Public classic GeoD clients cannot choose recipients, write receipts or publish notices. Deploy the public gateway compatibility route before publishing the desktop installer; no identity service change is needed.


# Release operations

Before publishing the desktop installer, deploy the public gateway compatibility route and verify anonymous reads. Existing messages continue targeting GeoD Agent unless explicitly marked `product: "geod"` or `"all"`. No identity service deployment or account grant is required. Publish real product updates only; do not broadcast QA messages.

