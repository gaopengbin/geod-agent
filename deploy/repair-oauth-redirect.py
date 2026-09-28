"""Repair the narrow GeoD OAuth login redirect in the active Nginx routes."""

import os
import shutil
import tempfile
from pathlib import Path

ROUTES = Path("/srv/laogao/config/geod/routes.conf")
BACKUP = Path("/srv/laogao/backups/geod-agent-20260928-65b5e65d/routes.before-oauth-redirect.conf")
OLD = """location = /api/geod/oauth/authorize {
    client_max_body_size 8k;
    proxy_pass http://127.0.0.1:9114;
    include /srv/laogao/config/geod/proxy.conf;
}"""
NEW = OLD[:-1] + "    proxy_redirect https://localhost:9114/ https://geod.laogao.xyz/;\n}"

contents = ROUTES.read_text()
if contents.count(OLD) != 1:
    raise SystemExit("Expected exactly one unchanged GeoD OAuth route")
if BACKUP.exists():
    if BACKUP.read_text() != contents:
        raise SystemExit("OAuth route backup differs from the active pre-change route")
else:
    shutil.copy2(ROUTES, BACKUP)
descriptor, temporary = tempfile.mkstemp(prefix="routes.oauth-", dir=ROUTES.parent)
try:
    os.fchmod(descriptor, ROUTES.stat().st_mode)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(contents.replace(OLD, NEW, 1))
    os.replace(temporary, ROUTES)
except BaseException:
    Path(temporary).unlink(missing_ok=True)
    raise
print("GeoD OAuth redirect route updated; previous route backed up")
