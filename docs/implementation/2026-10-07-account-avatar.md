# GeoD account avatar synchronization

## Omission found

The desktop OAuth flow stored account ID and credentials, while both avatar slots always rendered `UserRound`. The deployed GeoD account website already supports six presets and uploaded WebP avatars. Its profile and avatar GET routes accepted browser cookies only.

## Changes

- Native `account_profile` reads the identity service directly with the desktop OAuth token. Credentials remain in the native process and Windows credential vault.
- Uploaded avatar response is limited to 512 KiB, must be WebP, and has dimensions at most 512 by 512. Profile response is limited to 16 KiB. Redirects do not receive credentials.
- Requests verify the expected account ID before and after fetching. Frontend state additionally discards responses from signed-out or previous accounts.
- Sidebar and account menu share the same profile. Uploaded images stay in the existing 30 px circle; preset palette and default account-ID hash match the account website.
- Profile is loaded on sign-in and refreshed when returning to the app or opening the account menu, at most once per 30 seconds. Errors do not block existing authentication; the menu offers explicit retry. No continuous polling or account changes are made.
- Account menu shows the real account email when available instead of only the UUID.
- Nicknames are edited in the website dashboard's personal profile section. The website account store owns the field; Agent only reads and displays it. Defaults are `geod` plus six random lowercase letters/digits, generated once and saved; clearing a custom nickname generates a new default. Names are trimmed, limited to 40 Unicode characters, and cannot contain controls or line breaks.
- Website nickname mutations use the existing `/api/account` route with PATCH, browser cookies, same-origin validation, and a transaction-time account/session check. Desktop OAuth bearer grants cannot edit profile data.
- Identity-side read-only support, tests and production receipt are saved in `deploy/identity-profile` and `artifacts/account-avatar-20261007`.

## Verification

- Desktop TypeScript and frontend production build passed.
- Real App with isolated native IPC: preset and uploaded-image display, broken-image fallback, explicit retry, logout, delayed-response account isolation, and existing login-page checks.
- Identity service: real OAuth grant exchange with an isolated account store, preset and uploaded bytes, owner isolation, revoked/expired/disabled/malformed grant rejection, cookie-contract compatibility, and read-only authorization.
- Real account avatars have not been modified for testing. Production nickname defaults were backfilled during the authorized deployment; the running native build subsequently read nickname and avatar metadata successfully.

Evidence: `artifacts/login-screen-20261007/ui-acceptance.json`, `avatar-upload-dark.png`. Rust adapter tests cover request authorization, response ownership, legacy/error responses and image bounds.

## Nickname verification and current delivery status

- 27 identity tests passed across profile, avatar, OAuth, and verification suites; production build and TypeScript validation passed. Registration paths generate defaults, legacy blanks are persisted once, custom names stay unchanged, and nickname migration preserves read-only behavior for unrelated fields.
- 4 native adapter tests passed, including optional nickname compatibility, Unicode names, bounds and malformed names.
- 14 desktop UI checks passed, including synchronized nickname/avatar slots and delayed response isolation after account switching.
- Website production build passed. Isolated UI checks verified persistence after reload, Enter to save, clearing, validation and retry, plus rendered desktop and 390px layouts. The small-screen refresh button's visually hidden label was contained correctly to remove horizontal overflow.
- Frozen native development build `build-profile-20261007` passed and was switched only while idle. SHA-256: `fb7e66dc7850c2ae11685da0317055992f2a630a358bc06daf5c5927a36e5fcc`.
- The desktop restarted authenticated. All 138 persistent large state records matched before and after by SHA-256. Volatile message timestamps are deliberately excluded from this check; an earlier localStorage-only comparison was not evidence of history loss.
- Before deployment, live `account_profile` returned `PROFILE_RESPONSE` against the old production service. After deployment, the real native request succeeded with nickname, avatar metadata, and matching account ownership.
- Website source uses the independent managed worktree `geod-account-profile` based on `codex/geod-account-portal`; the older cwd website was not used. Reviewable identity and website patches, source hashes and static website archive are retained under `deploy/identity-profile` and `artifacts/account-avatar-20261007`.

Website screenshots: `website-profile-desktop.png`, `website-profile-mobile.png`. Reports: `website-ui-acceptance.json`, `native-profile-after.json`.

The identity production build also passed. Its Linux-compatible package combines the new server JavaScript and static assets with the SHA-256-verified existing Linux runtime dependencies (unchanged package dependency versions). A local Docker test with external networking disabled passed nickname save/clear and OAuth reads, preset/uploaded avatar delivery with real Linux Sharp, cookie/OAuth compatibility, authorization rejection, and native SQLite loading. Build provenance is explicit in `linux-profile-package.json`.

## Production delivery — 2026-10-07

The user explicitly authorized publishing. Release `geod-profile-20261007-132810-a32b2fc9d2c2` deployed identity `b6fcd801a2c2168036d7edef34c66c05fc15a01d` and website `88319db2997ff7fc79d154a97b18db0a689509be`.

- Backup: `/srv/laogao/backups/geod-profile-20261007-132810-a32b2fc9d2c2`; old releases and old stopped PM2 entry retained.
- Isolated production-host candidate checks passed before the switch. All 90 website HTTP responses matched the locally reviewed files by SHA-256; 30 referenced legacy Studio JS/CSS resources loaded.
- Six unique default nicknames persisted. All other user fields matched the pre-deployment backup; avatars were not modified. Existing routes and unrelated online process PIDs were preserved.
- Running native development app: connected, profile fetched, nickname present, avatar metadata present, account owner matched. This verifies actual client-to-production integration. This turn did not publish a new desktop installer.
- Browser automation timed out during the live visual check. Local desktop/mobile screenshots remain valid local acceptance evidence, not screenshots of the live site.

Reports: `production-deployment.json`, `production-post-verify.json`, `native-profile-production.json`, `production-after.json` under `artifacts/account-avatar-20261007`. Website nickname entry: `https://geod.laogao.xyz/dashboard#profile`.
