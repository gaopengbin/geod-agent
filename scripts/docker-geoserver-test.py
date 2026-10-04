"""Publish the isolated PostGIS fixtures as real local WFS data."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
state = root / "infra/postgis-test/.secrets"
parser = argparse.ArgumentParser()
parser.add_argument("--stop", action="store_true")
args = parser.parse_args()
state.mkdir(parents=True, exist_ok=True)
password_file = state / "geoserver-password.txt"
if not password_file.exists():
    password_file.write_text(secrets.token_urlsafe(32), encoding="utf-8")
command = ["docker", "compose", "-f", str(root / "infra/postgis-test/compose.yaml"), "--profile", "online"]
if args.stop:
    subprocess.run(command + ["stop", "geoserver"], check=True)
    raise SystemExit()
draft = json.loads((state / "reader-connection.json").read_text(encoding="utf-8"))
subprocess.run(command + ["up", "-d", "--wait", "--wait-timeout", "180", "geoserver"], check=True)
base = "http://127.0.0.1:18083/geoserver"
authorization = "Basic " + base64.b64encode(("geod_admin:" + password_file.read_text().strip()).encode()).decode()

def rest(path, value=None, method="GET"):
    body = None if value is None else json.dumps(value, ensure_ascii=False).encode()
    request = urllib.request.Request(base + "/rest/" + path, body, {"Authorization": authorization, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, None
        # Error bodies can echo a submitted datastore password.
        raise RuntimeError(f"GeoServer REST {method} {path} returned HTTP {error.code}") from None

deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    try:
        code, body = rest("about/version.json")
        if code == 200:
            break
    except (OSError, RuntimeError):
        pass
    time.sleep(0.5)
else:
    raise RuntimeError("GeoServer REST did not become ready")
if rest("workspaces/geod.json")[0] == 404:
    rest("workspaces", {"workspace": {"name": "geod"}}, "POST")
datastore = "workspaces/geod/datastores/postgis_test"
if rest(datastore + ".json")[0] == 404:
    parameters = {"dbtype": "postgis", "host": "postgis", "port": "5432", "database": draft["database"], "schema": "demo", "user": draft["user"], "passwd": draft["password"], "namespace": "http://geod", "validate connections": "true"}
    rest("workspaces/geod/datastores", {"dataStore": {"name": "postgis_test", "connectionParameters": {"entry": [{"@key": key, "$": value} for key, value in parameters.items()]}}}, "POST")
for name, table in [("boundary", "boundaries_4326"), ("regions", "multiple_regions"), ("many_regions", "big_area")]:
    if rest(datastore + "/featuretypes/" + name + ".json")[0] == 404:
        rest(datastore + "/featuretypes", {"featureType": {"name": name, "nativeName": table, "srs": "EPSG:4326", "projectionPolicy": "FORCE_DECLARED", "enabled": True}}, "POST")
print(json.dumps({"endpoint": base, "version": json.loads(body), "layers": ["geod:boundary", "geod:regions", "geod:many_regions"]}, ensure_ascii=False), flush=True)
