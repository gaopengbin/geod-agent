"""Set a safe referrer policy for browser form submission on the OAuth route."""

import os
import shutil
import tempfile
from pathlib import Path

ROUTES = Path("/srv/laogao/config/geod/routes.conf")
BACKUP = Path("/srv/laogao/backups/geod-agent-20260928-65b5e65d/routes.before-oauth-origin.conf")
OLD = """location = /api/geod/oauth/authorize {
    client_max_body_size 8k;
    proxy_pass http://127.0.0.1:9114;
    include /srv/laogao/config/geod/proxy.conf;
    proxy_redirect https://localhost:9114/ https://geod.laogao.xyz/;
}"""
NEW = OLD[:-1] + "    proxy_hide_header Referrer-Policy;\n    add_header Referrer-Policy origin always;\n}"

contents = ROUTES.read_text()
if contents.count(OLD) != 1:
    raise SystemExit("Expected exactly one current GeoD OAuth route")
if BACKUP.exists():
    raise SystemExit("OAuth origin backup already exists")
shutil.copy2(ROUTES, BACKUP)
descriptor, temporary = tempfile.mkstemp(prefix="routes.oauth-origin-", dir=ROUTES.parent)
try:
    os.fchmod(descriptor, ROUTES.stat().st_mode)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(contents.replace(OLD, NEW, 1))
    os.replace(temporary, ROUTES)
except BaseException:
    Path(temporary).unlink(missing_ok=True)
    raise
print("GeoD OAuth form origin route updated; previous route backed up")
