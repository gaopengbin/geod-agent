# GeoD desktop account profile

The local patch extends the existing GeoD account authority. It does not create an Agent-specific user store. `source.json` records the tested release checkout and its base revision.

Apply `geod-desktop-profile.patch` to that base with `git apply --check` first. The patch was verified against the recorded base. Changes extend the account response, uploaded-avatar GET path, and website-only nickname editing with `PATCH /api/account`. Existing reverse-proxy account routes can serve these paths. `geod-website-nickname.patch` and `website-source.json` record the matching static website change on the current account-portal branch.

- A desktop Bearer grant must be active, unexpired, unrevoked, for client `geod-agent-desktop`, with scope `geod:agent` and an enabled account.
- Desktop profile response contains only account ID, email, optional nickname and avatar metadata. Browser cookie response keeps its current contract and gains the optional nickname field.
- Avatar bytes are served only for the authenticated owner. Query parameters cannot select another account.
- Bearer authorization is read-only. Upload, preset selection and removal retain browser-session authentication and same-origin checks.
- Nickname editing is available in the website account page only. `PATCH /api/account` requires an active browser session and same origin, rejects authorization headers and unknown fields, limits nicknames to 40 Unicode characters, and restores a generated default when cleared. The account owner is rechecked inside the store transaction.
- Default nickname policy: lowercase `geod` followed by six securely random lowercase letters/digits, allocated without collisions against current nicknames under the store lock. Both invite and verified signup paths generate and persist the default. Missing legacy names are backfilled once on a successful transaction; custom names are preserved. Read-only transactions persist only the nickname migration, never unrelated changes in their callback. Clients only display this server-owned name.
- No browser cookies, password hashes, gateway secret, quota or storage records are sent to the desktop profile request.
- Invalid Bearer headers fail closed rather than falling back to a browser cookie.

Local validation: 27 identity/profile/avatar/OAuth/verification tests; identity production build and TypeScript check; website production build and isolated desktop/mobile UI checks; 4 native profile adapter tests; 14 real desktop UI fixture checks. The development desktop has been restarted with the new adapter, with all 138 large persistent state records matching before and after the restart. The initial live read against the old service returned `PROFILE_RESPONSE`; the post-deployment native read succeeded with nickname, avatar metadata, and matching account ownership.

The identity production build passed and a Linux-compatible package was assembled using the existing verified Linux dependencies with unchanged dependency versions. A Docker Node 22.23.2 check with network disabled passed nickname cookie writes/OAuth reads, real Linux Sharp image upload and WebP delivery, authorization boundaries, existing cookie/OAuth compatibility and Linux SQLite loading. Package provenance and SHA-256 are recorded in `artifacts/account-avatar-20261007/linux-profile-package.json`. The first cold bind-mounted run exceeded its 5-second request timeout; the same checks passed with a 30-second cold-start allowance.

## Production deployment — 2026-10-07

Published with the user's explicit “上线” authorization as `geod-profile-20261007-132810-a32b2fc9d2c2`. Identity commit `b6fcd801a2c2168036d7edef34c66c05fc15a01d`; website commit `88319db2997ff7fc79d154a97b18db0a689509be`. Backup: `/srv/laogao/backups/geod-profile-20261007-132810-a32b2fc9d2c2`.

- An isolated candidate on the production Linux host passed browser nickname writes, default reset, OAuth profile reads, preset avatar metadata, and authorization boundaries before switching.
- Live HTTP SHA-256 matched all 90 website responses; 30 referenced legacy Studio JS/CSS resources loaded. Nginx configuration and unrelated process PIDs stayed unchanged.
- All six existing accounts received unique persisted `geod` plus six-character defaults. Other user fields matched the backup exactly; no avatars or custom names were changed for testing.
- The running native development app read the real production profile successfully, including nickname and avatar metadata, with the expected account owner.
- Live browser visual review could not complete because the automation connection timed out. Local rendered desktop/mobile UI checks passed; HTTP validation is recorded separately from visual acceptance.

Full receipt: `artifacts/account-avatar-20261007/production-deployment.json`. Old identity and website releases and the stopped old PM2 entry remain available for rollback. Account changes are additive; code rollback must preserve intervening writes and the newly assigned default names.
