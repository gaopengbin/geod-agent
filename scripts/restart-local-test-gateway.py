"""Preserve the actual development ledger and restart its verified listening process."""
from pathlib import Path
import datetime, json, os, sqlite3, subprocess, sys
import psutil

from windows_detached_process import independent_entrypoint
if independent_entrypoint(__file__,sys.argv[1:],label='development-gateway'):
    raise SystemExit(0)

root=Path(__file__).resolve().parents[1]
logs=Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/dev-logs'
script=(root/'services/geod-agent-model-gateway/dev/local-desktop-gateway.mjs').resolve()
pids={c.pid for c in psutil.net_connections(kind='tcp') if c.pid and c.laddr and c.laddr.ip=='127.0.0.1' and c.laddr.port==43123 and c.status=='LISTEN'}
matches=[]
for pid in pids:
    process=psutil.Process(pid)
    command=process.cmdline()
    if len(command)>1 and Path(command[1]).resolve()==script:
        matches.append(process)
if len(matches)!=1:
    raise SystemExit('Expected exactly one verified GeoD local test gateway on port 43123')
process=matches[0]
created=process.create_time()
source=process.environ().get('GEOD_LOCAL_GATEWAY_DB_PATH')
target=logs/'local-gateway.sqlite'
if not source:
    raise SystemExit('Gateway ledger path unavailable; refusing to replace an unverified ledger')
source=Path(source).resolve()
with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as ledger:
    if ledger.execute("SELECT COUNT(*) FROM model_generations WHERE state IN ('reserved','streaming')").fetchone()[0]:
        raise SystemExit('A model request is still active; finish it before restarting')
    if source!=target.resolve():
        with sqlite3.connect(target) as destination:
            ledger.backup(destination)
    backup=logs/('local-gateway-backup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
    with sqlite3.connect(backup) as destination:
        ledger.backup(destination)
assert process.create_time()==created and Path(process.cmdline()[1]).resolve()==script
process.terminate()
process.wait(timeout=10)
subprocess.run([sys.executable,'-X','utf8',str(root/'services/geod-agent-model-gateway/dev/start-local-gateway.py'),'--existing-config'],check=True)
print(json.dumps({'developmentGatewayRestartRequested':True,'ledgerPreserved':True}))
