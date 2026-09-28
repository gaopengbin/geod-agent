"""Stage, smoke-test, and atomically switch the GeoD Studio OAuth release."""

import hashlib
import http.client
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from urllib.parse import urlencode

BASE = Path("/srv/laogao")
OLD = BASE / "releases/geod-studio/geod-oauth-20260928-65b5e65d"
NEW = BASE / "releases/geod-studio/geod-oauth-consent-20260928-d408012d"
CURRENT = BASE / "current/geod-studio"
STAGING = BASE / "staging/geod-agent-20260928-65b5e65d-69a6c52d"
ARCHIVE = STAGING / "geod-oauth-studio-consent-linux-x64-20260928.tar.gz"
PM2_CONFIG = STAGING / "geod-studio-consent-20260928.config.cjs"
STUDIO_ENV = BASE / "secrets/geod-studio.env"
BACKUP = BASE / "backups/geod-agent-20260928-65b5e65d"
EXPECTED_HASH = "d408012d2c89ac94f8781c1e64a10d8a5597c7008eb644794438637d2e4e810b"
OLD_NAME = "geod-studio-geod-oauth-20260928"
NEW_NAME = "geod-studio-geod-consent-20260928"


def request(port, path, method="GET", body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
    try:
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        content = response.read(8192)
        return response.status, {name.lower(): value for name, value in response.getheaders()}, content
    finally:
        connection.close()


def oauth_path():
    query = urlencode({
        "response_type": "code", "client_id": "geod-agent-desktop",
        "redirect_uri": "http://127.0.0.1:4723/oauth/callback",
        "code_challenge": "c" * 43, "code_challenge_method": "S256",
        "scope": "geod:agent", "state": "s" * 32,
    })
    return f"/api/geod/oauth/authorize?{query}"


def check_identity(port):
    status, headers, _ = request(port, oauth_path())
    if status != 303 or not headers.get("location", "").startswith("/login?returnTo="):
        raise RuntimeError(f"OAuth redirect failed: HTTP {status}")
    status, _, content = request(port, "/api/geod/oauth/authorize", "POST", "", {
        "Origin": "https://geod.laogao.xyz", "Content-Type": "application/x-www-form-urlencoded",
    })
    if status not in (400, 401) or b"ORIGIN_REJECTED" in content:
        raise RuntimeError(f"Same-origin OAuth POST failed: HTTP {status}")
    status, _, _ = request(port, "/api/account/session")
    if status != 200:
        raise RuntimeError(f"Account session compatibility failed: HTTP {status}")


def stage():
    if CURRENT.resolve(strict=True) != OLD or not CURRENT.is_symlink():
        raise RuntimeError("Studio release changed; refusing to stage")
    if NEW.exists() or NEW.is_symlink():
        raise RuntimeError("Target release already exists")
    if hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() != EXPECTED_HASH:
        raise RuntimeError("Studio archive hash mismatch")
    with tarfile.open(ARCHIVE, "r:gz") as source:
        members = source.getmembers()
        if not members or any(
            not (member.isfile() or member.isdir())
            or member.name.startswith("/")
            or ".." in Path(member.name).parts
            for member in members
        ):
            raise RuntimeError("Unsafe Studio archive")
        web = NEW / "web"
        web.mkdir(parents=True, exist_ok=False)
        source.extractall(web, filter="data")
    if not (web / "server.js").is_file() or not (web / ".next/BUILD_ID").is_file():
        raise RuntimeError("Studio build is incomplete")
    if (web / "node_modules/better-sqlite3/build/Release/better_sqlite3.node").read_bytes()[:4] != b"\x7fELF":
        raise RuntimeError("Studio SQLite addon is not a Linux binary")
    subprocess.run(["chown", "-R", "ubuntu:ubuntu", str(web)], check=True)
    print(f"Staged {NEW.name}; SHA256 {EXPECTED_HASH}")


def smoke():
    web = NEW / "web"
    if not (web / "server.js").is_file():
        raise RuntimeError("Stage the candidate first")
    environment = os.environ.copy()
    environment.update({
        "NODE_ENV": "production", "HOSTNAME": "127.0.0.1", "PORT": "9116",
        "GEOD_IMAGE_RECOVERY_WORKER": "false",
        "GEOD_STUDIO_DATA_DIR": str(BASE / "data/geod-studio/studio"),
    })
    process = subprocess.Popen(
        ["node", f"--env-file={STUDIO_ENV}", "server.js"], cwd=web,
        env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        last_error = "not ready"
        for _ in range(40):
            if process.poll() is not None:
                raise RuntimeError("Studio candidate exited before its smoke test")
            try:
                check_identity(9116)
                (web / "candidate-ok.txt").write_text(EXPECTED_HASH + "\n", encoding="ascii")
                print("Studio candidate OAuth redirect, POST guard, and account session passed on 9116")
                return
            except (OSError, RuntimeError) as error:
                last_error = str(error)
                time.sleep(0.25)
        raise RuntimeError(f"Studio candidate did not pass smoke tests: {last_error}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def pm2(*args):
    subprocess.run(["pm2", *args], check=True, stdout=subprocess.DEVNULL)


def point_current(target):
    temporary = CURRENT.with_name("geod-studio.consent-next")
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError("Temporary Studio symlink already exists")
    os.symlink(target, temporary)
    os.replace(temporary, CURRENT)


def switch():
    if CURRENT.resolve(strict=True) != OLD or not CURRENT.is_symlink():
        raise RuntimeError("Studio release changed before switch")
    if (NEW / "web/candidate-ok.txt").read_text(encoding="ascii").strip() != EXPECTED_HASH:
        raise RuntimeError("Candidate smoke marker missing or mismatched")
    symlink_backup = BACKUP / "studio-before-geod-consent-20260928.txt"
    account_backup = BACKUP / "account-store-before-geod-consent-20260928.json"
    if symlink_backup.exists() or account_backup.exists():
        raise RuntimeError("Consent release backup already exists")
    account_dir = None
    for line in STUDIO_ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith("GEOSTYLE_ACCOUNT_DIR="):
            account_dir = Path(line.split("=", 1)[1].strip().strip('"\''))
            break
    if not account_dir or not account_dir.is_absolute() or not account_dir.is_relative_to(BASE / "data"):
        raise RuntimeError("Account data directory is not the expected persistent path")
    shutil.copy2(account_dir / "store.json", account_backup)
    account_backup.chmod(0o600)
    symlink_backup.write_text(str(OLD) + "\n", encoding="ascii")
    stopped = False
    try:
        pm2("stop", OLD_NAME)
        stopped = True
        point_current(NEW)
        pm2("start", str(PM2_CONFIG))
        for _ in range(40):
            try:
                check_identity(9114)
                break
            except (OSError, RuntimeError):
                time.sleep(0.25)
        else:
            raise RuntimeError("New Studio failed post-switch smoke test")
        pm2("delete", OLD_NAME)
        pm2("save")
    except Exception:
        subprocess.run(["pm2", "delete", NEW_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if CURRENT.resolve(strict=False) != OLD:
            point_current(OLD)
        if stopped:
            subprocess.run(["pm2", "restart", OLD_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise
    print(f"Published {NEW.name}; rollback release {OLD.name}; account backup retained")


if __name__ == "__main__":
    {"stage": stage, "smoke": smoke, "switch": switch}[sys.argv[1]]()
