"""Start/stop GeoD's isolated Docker PostGIS fixture. No existing services changed.

Run through uvx with psycopg[binary]==3.2.12. Credentials use a gitignored folder.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import psycopg
from psycopg import sql

root = Path(__file__).resolve().parents[1]
state = root / "infra/postgis-test/.secrets"
compose = root / "infra/postgis-test/compose.yaml"
parser = argparse.ArgumentParser()
parser.add_argument("--stop", action="store_true")
args = parser.parse_args()
state.mkdir(parents=True, exist_ok=True)
passwords = {}
for role in ("admin", "reader"):
    path = state / (role + "-password.txt")
    if not path.exists():
        path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
    passwords[role] = path.read_text(encoding="utf-8").strip()
environment = dict(os.environ)
command = ["docker", "compose", "-f", str(compose)]
if args.stop:
    subprocess.run(command + ["stop"], env=environment, check=True)
    raise SystemExit()
existing = subprocess.run(["docker", "inspect", "geod-agent-postgis-test"], capture_output=True)
if existing.returncode == 0:
    info = json.loads(existing.stdout)[0]
    if info["Config"].get("Labels", {}).get("com.geod.purpose") != "data-input-integration-test":
        raise RuntimeError("The requested container name belongs to another service")
subprocess.run(command + ["up", "-d", "--wait", "--wait-timeout", "120"], env=environment, check=True)
with psycopg.connect(host="127.0.0.1", port=55438, dbname="geod_test", user="geod_admin", password=passwords["admin"], sslmode="disable") as connection:
    connection.execute(sql.SQL("ALTER ROLE geod_reader LOGIN PASSWORD {}").format(sql.Literal(passwords["reader"])))
    versions = connection.execute("SELECT current_setting('server_version'), postgis_version()").fetchone()
reader = {"name": "Docker PostGIS 测试库", "host": "127.0.0.1", "port": 55438, "database": "geod_test", "user": "geod_reader", "sslMode": "disable", "password": passwords["reader"]}
(state / "reader-connection.json").write_text(json.dumps(reader, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"container": "geod-agent-postgis-test", "endpoint": "127.0.0.1:55438", "database": "geod_test", "user": "geod_reader", "postgresql": versions[0], "postgis": versions[1], "credentialFile": str(state / "reader-connection.json")}, ensure_ascii=False), flush=True)
