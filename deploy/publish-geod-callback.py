"""Publish the callback CSP repair using the checked GeoD Studio release workflow."""

import importlib.util
import sys
from pathlib import Path

source = Path(__file__).with_name("publish-geod-consent.py")
spec = importlib.util.spec_from_file_location("geod_consent_release", source)
assert spec and spec.loader
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

release.OLD = release.BASE / "releases/geod-studio/geod-oauth-consent-20260928-d408012d"
release.NEW = release.BASE / "releases/geod-studio/geod-oauth-callback-20260928-cce65916"
release.ARCHIVE = release.STAGING / "geod-oauth-studio-callback-linux-x64-20260928.tar.gz"
release.PM2_CONFIG = release.STAGING / "geod-studio-callback-20260928.config.cjs"
release.EXPECTED_HASH = "cce6591630fc1ea7ee8f3fd59879b00d8da32944b0185004142b8842a91d237c"
release.OLD_NAME = "geod-studio-geod-consent-20260928"
release.NEW_NAME = "geod-studio-geod-callback-20260928"
release.BACKUP_LABEL = "geod-callback-20260928"

{"stage": release.stage, "smoke": release.smoke, "switch": release.switch}[sys.argv[1]]()
