"""Exercise Docker PostGIS through the desktop's actual native input commands."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid
import psycopg

root = Path(__file__).resolve().parents[1]
state = root / "infra/postgis-test/.secrets"
draft = json.loads((state / "reader-connection.json").read_text(encoding="utf-8"))
conversation = "docker-postgis-native-" + str(uuid.uuid4())
report = []

def rpc(command, args=None):
    request = urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps({"command": command, "args": args or {}}).encode(), {"Content-Type": "application/json"})
    response = json.load(urllib.request.urlopen(request, timeout=190))
    if response.get("error"):
        raise RuntimeError(str(response["error"]))
    return response["value"]

def connect(user="geod_reader", **kwargs):
    password = draft["password"] if user == "geod_reader" else (state / "admin-password.txt").read_text().strip()
    return psycopg.connect(host=draft["host"], port=draft["port"], dbname=draft["database"], user=user, password=password, sslmode="disable", **kwargs)

def snapshot():
    with connect("geod_admin") as connection:
        return connection.execute("SELECT (SELECT count(*) FROM demo.big_area), (SELECT count(*) FROM demo.scoped_regions), md5(ST_AsEWKB(geom)::text) FROM demo.boundaries_4326").fetchone()

def record(name, check):
    try:
        details = check() or {}
        report.append({"case": name, "pass": True, **details})
        print(name, "PASS", flush=True)
    except Exception as error:
        report.append({"case": name, "pass": False, "error": str(error)})
        print(name, "FAIL", str(error), flush=True)

existing = rpc("data_connections_list")
found = next((connection for connection in existing if all(connection.get(key) == draft[key] for key in ("name", "host", "port", "database", "user"))), None)
saved = {"connection": found} if found else rpc("data_connection_save", {"draft": draft})
assert saved.get("connection"), saved
connection_id = saved["connection"]["id"]

def read(layer=None):
    request = {"connectionId": connection_id}
    if layer:
        request["layer"] = layer
    return rpc("data_input_read", {"conversationId": conversation, "request": request})

with connect("geod_admin") as connection:
    version, postgis = connection.execute("SELECT version(),postgis_full_version()").fetchone()
baseline = snapshot()

def discovery():
    result = read()
    names = [layer["name"] for layer in result["layers"]]
    assert result["selectionRequired"] and len(names) >= 13, result
    assert "demo.boundaries_3857.geom" in names and "demo.nullable_area.backup_geom" in names
    assert not any(name.startswith("hidden.") for name in names), names
    return {"layerCount": len(names), "layers": result["layers"]}
record("native layer discovery and table visibility", discovery)

def polygon(layer, count=1):
    result = read(layer)
    boundary = result.get("boundary")
    assert boundary, result
    expected = [116.1,39.6,116.3 + (0.4 if count == 2 else 0),39.8]
    assert max(abs(a-b) for a,b in zip(boundary["bounds"], expected)) < 1e-6, boundary["bounds"]
    assert boundary["polygonCount"] == count and all(len(polygon) == 2 for polygon in boundary["geometry"]["polygons"]), boundary
    return {"bounds": boundary["bounds"], "polygonCount": boundary["polygonCount"], "sourceCrs": result["sourceCrs"], "holesPreserved": True}

for label, layer, count in [
    ("WGS84 polygon with a hole", "demo.boundaries_4326.geom", 1),
    ("EPSG:3857 to WGS84", "demo.boundaries_3857.geom", 1),
    ("MultiPolygon", "demo.multiple_regions.geom", 2),
    ("NULL rows skipped", "demo.nullable_area.geom", 1),
    ("second geometry column", "demo.nullable_area.backup_geom", 1),
    ("spatial SQL view", "demo.projected_view.geom", 1),
    ("Unicode quoted SQL identifiers", 'demo.区划 odd" table.边界 odd', 1),
    ("row level security", "demo.scoped_regions.geom", 1),
]:
    record("native " + label, lambda layer=layer,count=count: polygon(layer,count))

def error_case(layer, code):
    result = read(layer)
    assert result.get("error", {}).get("code") == code, result
    assert draft["password"] not in json.dumps(result), "Credential leaked into error"
    return {"code": code}

for name, layer, code in [
    ("empty layer", "demo.empty_area.geom", "INPUT_EMPTY"),
    ("point rejected as boundary", "demo.points.geom", "INPUT_NOT_POLYGON"),
    ("invalid polygon", "demo.invalid_area.geom", "INPUT_INVALID_GEOMETRY"),
    ("SRID zero", "demo.unknown_crs.geom", "INPUT_CRS_REQUIRED"),
    ("10,001 features not silently truncated", "demo.big_area.geom", "INPUT_TOO_LARGE"),
    ("private table denied", "hidden.private_area.geom", "INPUT_LAYER_NOT_FOUND"),
    ("unlisted SQL-like identifier denied", 'demo.boundaries_4326.geom; DROP TABLE demo.points;--', "INPUT_LAYER_NOT_FOUND"),
]:
    record("native " + name, lambda layer=layer,code=code: error_case(layer,code))

def wrong_password():
    before = len(rpc("data_connections_list"))
    invalid = dict(draft, name="Must not be saved", password=uuid.uuid4().hex)
    response = rpc("data_connection_save", {"draft": invalid})
    assert response.get("error", {}).get("code") == "INPUT_AUTH_REQUIRED", response
    assert invalid["password"] not in json.dumps(response)
    assert len(rpc("data_connections_list")) == before
    return {"code": response["error"]["code"], "saved": False}
record("invalid credentials fail without saving or disclosure", wrong_password)

def credential_privacy():
    assert "password" not in json.dumps(rpc("data_connections_list"))
record("native credential metadata excludes password", credential_privacy)

def read_only():
    with connect(options="-c default_transaction_read_only=on -c statement_timeout=15000") as connection:
        try:
            connection.execute("INSERT INTO demo.points VALUES (ST_SetSRID(ST_MakePoint(0,0),4326))")
            raise AssertionError("Read-only write unexpectedly allowed")
        except psycopg.errors.ReadOnlySqlTransaction:
            connection.rollback()
    return {"sqlState": "25006"}
record("native connection options block writes", read_only)

def select_role():
    with connect(options="-c default_transaction_read_only=off") as connection:
        try:
            connection.execute("INSERT INTO demo.points VALUES (ST_SetSRID(ST_MakePoint(0,0),4326))")
            raise AssertionError("SELECT-only account unexpectedly wrote data")
        except psycopg.errors.InsufficientPrivilege:
            connection.rollback()
    return {"sqlState": "42501"}
record("SELECT-only database role independently blocks writes", select_role)

def unchanged():
    assert snapshot() == baseline
    return {"featureCounts": list(baseline[:2]), "geometryHashUnchanged": True}
record("reads and rejected operations leave fixtures unchanged", unchanged)

def restart():
    subprocess.run(["docker", "restart", "--time", "10", "geod-agent-postgis-test"], check=True, capture_output=True)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        healthy = subprocess.check_output(["docker", "inspect", "--format", "{{.State.Health.Status}}", "geod-agent-postgis-test"], text=True).strip()
        if healthy == "healthy":
            break
        time.sleep(0.5)
    else:
        raise RuntimeError("Container failed to become healthy after restart")
    unchanged()
    return {"containerHealthy": True, "connectionIdRetained": connection_id, **polygon("demo.boundaries_3857.geom")}
record("container restart preserves data and native saved connection", restart)

image = subprocess.check_output(["docker", "inspect", "--format", "{{.Config.Image}}", "geod-agent-postgis-test"], text=True).strip()
out = {"conversationId": conversation, "connectionId": connection_id, "container": "geod-agent-postgis-test", "image": image, "postgresql": version, "postgis": postgis, "cases": report}
Path(os.environ.get("GEOD_TEST_REPORT", str(root / "docs/implementation/evidence/docker-postgis-native-2026-10-01.json"))).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{sum(row['pass'] for row in report)}/{len(report)} passed. Saved connection retained for user testing.", flush=True)
assert all(row["pass"] for row in report)
