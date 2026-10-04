"""Create/remove only a uniquely named PostgreSQL acceptance database."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
SECRETS = ROOT / "infra/postgis-test/.secrets"


def execute(database, statement):
    # Fixture setup stays in the dedicated Docker service, with no system
    # Python database dependency and no password in a process argument.
    result = subprocess.run(["docker", "exec", "-i", "geod-agent-postgis-test", "psql",
                             "-U", "geod_admin", "-d", database, "-v", "ON_ERROR_STOP=1", "-At"],
                            input=statement.encode("utf-8"), capture_output=True, check=True,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    return result.stdout.decode("utf-8").strip()


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["create", "remove"])
parser.add_argument("descriptor")
args = parser.parse_args()
descriptor = Path(args.descriptor).resolve()
if descriptor.parent != SECRETS.resolve() or not descriptor.name.startswith("plain-acceptance-"):
    raise SystemExit("Fixture descriptors must stay in the test secrets directory")

if args.mode == "remove":
    data = json.loads(descriptor.read_text(encoding="utf-8"))
    database = data["draft"]["database"]
    suffix = database.removeprefix("geod_agent_plain_")
    if database != "geod_agent_plain_" + suffix or len(suffix) != 32 or any(c not in "0123456789abcdef" for c in suffix):
        raise SystemExit("Refusing to remove a database outside the unique fixture namespace")
    execute("postgres", f"DROP DATABASE {identifier(database)} WITH (FORCE);")
    descriptor.unlink()
    print("Removed the exact acceptance database and its local credential descriptor")
else:
    database = "geod_agent_plain_" + uuid.uuid4().hex
    marker = uuid.uuid4().hex
    table = '记录 odd" table'
    execute("postgres", f"CREATE DATABASE {identifier(database)} TEMPLATE template0;")
    try:
        assert execute(database, "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis');") == "f"
        name = "public." + identifier(table)
        notes = literal('tab\t换行\n引号"')
        details = literal(json.dumps({"nested": "实际属性"}, ensure_ascii=False))
        second = literal(json.dumps({"nested": "二"}, ensure_ascii=False))
        execute(database, f"CREATE TABLE {name} (id integer,name text,score integer,notes text,details jsonb);\n"
                          f"INSERT INTO {name} VALUES (1,{literal(marker)},7,{notes},{details}::jsonb),(2,'第二条',11,'正常',{second}::jsonb);\n"
                          f"GRANT USAGE ON SCHEMA public TO geod_reader;\nGRANT SELECT ON {name} TO geod_reader;")
        draft = json.loads((SECRETS / "reader-connection.json").read_text(encoding="utf-8"))
        draft.update(database=database, name="普通 PostgreSQL 属性验收")
        descriptor.write_text(json.dumps({"draft": draft, "marker": marker, "table": "public." + table}, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"database": database, "marker": marker, "postgisInstalled": False}, ensure_ascii=False))
    except BaseException:
        execute("postgres", f"DROP DATABASE {identifier(database)} WITH (FORCE);")
        raise
