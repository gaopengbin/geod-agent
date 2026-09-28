"""Publish a verified GeoD account page as an immutable website release."""

import hashlib
import os
import shutil
import tarfile
from pathlib import Path

BASE = Path("/srv/laogao")
CURRENT = BASE / "current/geod-website"
EXPECTED_SOURCE = BASE / "releases/geod-website/geod-agent-login-20260928-1425f0e5"
TARGET = BASE / "releases/geod-website/geod-account-20260928-81122cd8"
ARCHIVE = BASE / "staging/geod-agent-20260928-65b5e65d-69a6c52d/geod-login-site-20260928.tar.gz"
BACKUP = BASE / "backups/geod-agent-20260928-65b5e65d/website-before-geod-account.txt"
EXPECTED_HASH = "81122cd8a83c40fe30d78115a28038ef3cfdcae86fa353f0dfb0a728893ad7a1"
MEMBERS = {
    "login.html", "account-assets/login.css", "account-assets/login.js",
    "geod-site/logo-horizontal.png", "geod-site/logo-symbol.png",
}

if CURRENT.resolve(strict=True) != EXPECTED_SOURCE or not CURRENT.is_symlink():
    raise SystemExit("GeoD website release changed; refusing to publish over it")
if TARGET.exists() or TARGET.is_symlink() or BACKUP.exists():
    raise SystemExit("GeoD account release or its backup already exists")
if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != EXPECTED_HASH:
    raise SystemExit("GeoD account archive hash mismatch")
with tarfile.open(ARCHIVE, "r:gz") as source:
    actual = {member.name for member in source.getmembers()}
    if actual != MEMBERS or any(not member.isfile() for member in source.getmembers()):
        raise SystemExit("GeoD account archive contains unexpected members")
    shutil.copytree(EXPECTED_SOURCE, TARGET, symlinks=True)
    for member in source.getmembers():
        destination = TARGET / member.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with source.extractfile(member) as stream, destination.open("wb") as output:
            shutil.copyfileobj(stream, output)
        destination.chmod(0o644)

html = (TARGET / "login.html").read_text(encoding="utf-8")
if "GeoStyle" in html or "GeoD" not in html or "/account-assets/login.js" not in html:
    raise SystemExit("GeoD login page content verification failed")
if not all((TARGET / name).is_file() for name in MEMBERS):
    raise SystemExit("GeoD login page assets are incomplete")
BACKUP.write_text(str(EXPECTED_SOURCE) + "\n", encoding="utf-8")
temporary_link = CURRENT.with_name("geod-website.account-next")
if temporary_link.exists() or temporary_link.is_symlink():
    raise SystemExit("Temporary website symlink already exists")
os.symlink(TARGET, temporary_link)
os.replace(temporary_link, CURRENT)
print(f"GeoD account website published: {TARGET.name}")
