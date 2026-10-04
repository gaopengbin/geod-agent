"""Actual native MCP reads against a disposable PostgreSQL database without GIS."""
import json
from pathlib import Path
import urllib.request
import uuid
import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "infra/postgis-test/.secrets"
DRAFT = json.loads((STATE / "reader-connection.json").read_text(encoding="utf-8"))
ADMIN_PASSWORD = (STATE / "admin-password.txt").read_text().strip()
DATABASE = "geod_mcp_plain_" + uuid.uuid4().hex
CONVERSATION = "plain-postgres-mcp-" + uuid.uuid4().hex
CASES = []


def rpc(command, args=None):
    request = urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps({"command": command, "args": args or {}}).encode(), {"Content-Type": "application/json"})
    result = json.load(urllib.request.urlopen(request, timeout=90))
    return {"error": result["error"]} if result.get("error") else result["value"]


def admin(database):
    return psycopg.connect(host=DRAFT["host"], port=DRAFT["port"], dbname=database, user="geod_admin", password=ADMIN_PASSWORD, sslmode="disable", autocommit=True)


def record(name, result):
    encoded = json.dumps(result, ensure_ascii=False)
    assert DRAFT["password"] not in encoded and ADMIN_PASSWORD not in encoded
    CASES.append({"case": name, "pass": True, "result": result})
    print(name, "PASS", flush=True)


connection_id = None
created = False
with admin("postgres") as setup:
    try:
        setup.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(DATABASE)))
        created = True
        with admin(DATABASE) as fixture:
            assert not fixture.execute("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis')").fetchone()[0]
            fixture.execute('CREATE TABLE public."测试 odd"" table" (id integer,name text,notes text,details jsonb)')
            fixture.execute('INSERT INTO public."测试 odd"" table" VALUES (%s,%s,%s,%s::jsonb)', (1, "中文名称", "tab\t换行\n'引号\"", '{"nested":"属性"}'))
            fixture.execute('GRANT USAGE ON SCHEMA public TO geod_reader')
            fixture.execute('GRANT SELECT ON public."测试 odd"" table" TO geod_reader')
        value = rpc("data_connection_save", {"draft": {**DRAFT, "database": DATABASE, "name": "普通 PostgreSQL MCP 实测"}})
        assert value.get("connection") and value["databaseType"] == "PostgreSQL", value
        connection_id = value["connection"]["id"]
        assert value["layers"] == [] and value["tables"] == [{"name": 'public.测试 odd" table', "type": "TABLE"}], value
        assert value["mcp"]["server"] == "pgedge-postgres-mcp"
        record("connect and discover tables without PostGIS", value)
        result = rpc("data_layer_inspect", {"connectionId": connection_id, "layer": 'public.测试 odd" table', "limit": 2})
        assert result["featureCount"] == 1 and all(not c["spatial"] for c in result["columns"]), result
        assert result["sampleRecords"] == [{"id": 1, "name": "中文名称", "notes": "tab\t换行\n'引号\"", "details": {"nested": "属性"}}], result
        record("read fields, Unicode, tabs, newlines and nested JSON through MCP", result)
        result = rpc("data_input_read", {"conversationId": CONVERSATION, "request": {"connectionId": connection_id, "layer": 'public.测试 odd" table'}})
        assert result["error"]["code"] == "INPUT_NOT_POLYGON", result
        record("ordinary records cannot become a clipping boundary", result)
        listed = next(c for c in rpc("data_connections_list") if c["id"] == connection_id)
        assert listed["databaseType"] == "PostgreSQL" and "password" not in listed
        record("persist database type without credentials", {"name": listed["name"], "databaseType": listed["databaseType"]})
    finally:
        if connection_id:
            rpc("data_connection_remove", {"connectionId": connection_id})
        if created:
            # Exact unique database created by this test; never touch user data.
            setup.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(DATABASE)))

output = ROOT / "docs/implementation/evidence/pgedge-plain-postgres-native-2026-10-01.json"
output.write_text(json.dumps({"postgisInstalled": False, "cases": CASES}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"{len(CASES)}/{len(CASES)} passed; temporary database and saved connection removed")
