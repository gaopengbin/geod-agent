"""Ephemeral Windows PostgreSQL/PostGIS for data input integration tests.

No Windows service, outside business data, loopback port only. Stop via --stop.
"""
from pathlib import Path
import argparse
import os
import secrets
import shutil
import subprocess
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument("--stop",action="store_true")
args=parser.parse_args()
base=Path(os.environ["TEMP"])/"geod-postgis-test"
bin=base/"pgsql/bin"
flags=subprocess.CREATE_NO_WINDOW
def run(command):
    result=subprocess.run([str(x) for x in command],capture_output=True,creationflags=flags)
    if result.returncode:
        raise RuntimeError(result.stdout.decode("utf-8",errors="replace")+result.stderr.decode("utf-8",errors="replace"))
    return result.stdout.decode("utf-8",errors="replace")
if args.stop:
    print(run([bin/"pg_ctl.exe","-D",base/"data","stop","-m","fast"]))
    raise SystemExit()
if not (bin/"initdb.exe").is_file():
    base.mkdir(exist_ok=True)
    with zipfile.ZipFile(Path(os.environ["TEMP"])/"geod-postgresql17.zip") as archive: archive.extractall(base)
    with zipfile.ZipFile(Path(os.environ["TEMP"])/"geod-postgis-pg17.zip") as archive:
        folder=base/"postgis"
        archive.extractall(folder)
    candidates=list((base/"postgis").rglob("postgis.control"))
    if not candidates: raise RuntimeError("PostGIS package has no extension control")
    extension=candidates[0].parent
    package=extension.parent.parent
    for child in package.iterdir():
        if child.is_dir() and child.name in ("bin","lib","share"):
            shutil.copytree(child,base/"pgsql"/child.name,dirs_exist_ok=True)
password_file=base/"test-password.txt"
if not password_file.exists(): password_file.write_text(secrets.token_urlsafe(24),encoding="utf-8")
if not (base/"data/PG_VERSION").exists():
    run([bin/"initdb.exe","-D",base/"data","-U","geod_test","--auth=scram-sha-256","--pwfile",password_file,"--encoding=UTF8","--locale=C"])
    with (base/"data/postgresql.conf").open("a",encoding="utf-8") as output: output.write("\nport=55437\nlisten_addresses='127.0.0.1'\n")
if not (base/"data/postmaster.pid").exists():
    # The server inherits handles on Windows. Use a file rather than a PIPE,
    # so subprocess.communicate doesn't wait for the daemon to close stdout.
    with (base/"pgctl.log").open("ab") as output:
        subprocess.run([str(bin/"pg_ctl.exe"),"-D",str(base/"data"),"-l",str(base/"postgres.log"),"start","-w"],stdout=output,stderr=output,check=True,creationflags=flags)
os.environ["PGPASSWORD"]=password_file.read_text(encoding="utf-8").strip()
print(run([bin/"psql.exe","-h","127.0.0.1","-p","55437","-U","geod_test","-d","postgres","-v","ON_ERROR_STOP=1","-c","CREATE EXTENSION IF NOT EXISTS postgis; CREATE TABLE IF NOT EXISTS input_polygons (id serial PRIMARY KEY, name text, geom geometry(Polygon,3857)); TRUNCATE input_polygons; INSERT INTO input_polygons(name,geom) VALUES ('Beijing test boundary',ST_Transform(ST_GeomFromText('POLYGON((116.1 39.6,116.3 39.6,116.3 39.8,116.1 39.8,116.1 39.6),(116.15 39.65,116.2 39.65,116.2 39.7,116.15 39.7,116.15 39.65))',4326),3857)); SELECT version(),postgis_version();"]))
print("Temporary PostGIS ready on 127.0.0.1:55437. Credential stays in test-password.txt.")
