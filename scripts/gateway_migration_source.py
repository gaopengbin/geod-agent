"""Read-only production observation and in-memory SQLite snapshots over pinned SSH.

Executed on the server through stdin. Never persist a remote backup, change the
running service, read its secret environment file, or contact a model provider.
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path('/srv/laogao/data/geod-agent')
FILES = [ROOT/'agent-model.sqlite', ROOT/'agent-model.sqlite-credits.sqlite']

def table_summary(connection):
    result = {}
    for (name,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        quoted = '"'+name.replace('"','""')+'"'
        columns = [r[1] for r in connection.execute('PRAGMA table_info('+quoted+')')]
        def encode(value):
            return {'binarySha256':hashlib.sha256(value).hexdigest()} if isinstance(value,bytes) else value
        records = sorted(json.dumps([encode(v) for v in row],ensure_ascii=False,separators=(',',':'))
                         for row in connection.execute('SELECT * FROM '+quoted))
        result[name] = {'count':len(records),'columns':columns,
                        'rowsSha256':hashlib.sha256('\n'.join(records).encode()).hexdigest()}
    return result

processes = json.loads(subprocess.check_output(['pm2','jlist']))
live = [r for r in processes if r.get('name','').startswith('geod-agent-') and r.get('pm2_env',{}).get('status')=='online']
assert len(live)==1,'Expected one current GeoD Agent service'
process = live[0]
script = Path(process['pm2_env']['pm_exec_path']).resolve()
assert script.is_relative_to(Path('/srv/laogao/releases/geod-agent'))
active = Path('/srv/laogao/current/geod-agent').resolve()
assert script.is_relative_to(active)
route = Path('/srv/laogao/config/geod/routes.conf')
result = {'observedAt':datetime.now(timezone.utc).isoformat(),
          'productionService':{'name':process['name'],'pid':process['pid'],'startedAt':process['pm2_env'].get('pm_uptime'),
             'release':str(active),'entrypoint':str(script),
             'serverSha256':hashlib.sha256((script.parent/'server.mjs').read_bytes()).hexdigest(),
             'nodeVersion':process['pm2_env'].get('node_version')},
          'routeSha256':hashlib.sha256(route.read_bytes()).hexdigest(),
          'readonly':True,'remoteFilesCreated':False,'secretEnvironmentFileRead':False,
          'pm2MetadataRead':True,'environmentValuesReturned':False,
          'modelRequestsSent':0,'databases':[]}

for path in FILES:
    assert path.is_file() and path.resolve().is_relative_to(ROOT.resolve())
    source = sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=10)
    source.execute('PRAGMA query_only=ON')
    copied = sqlite3.connect(':memory:')
    try:
        source.backup(copied)
        assert copied.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        payload = copied.serialize()
        assert len(payload)<=50*1024*1024
        record={'name':path.name,'bytes':len(payload),
            'sha256':hashlib.sha256(payload).hexdigest(),'tables':table_summary(copied)}
        if '--metadata-only' not in sys.argv:
            record['snapshotBase64']=base64.b64encode(payload).decode()
        result['databases'].append(record)
    finally:
        copied.close()
        source.close()

# Each database is a consistent SQLite snapshot; this is not an atomic snapshot
# spanning the two independently committed ledgers.
result['crossDatabaseAtomicSnapshotClaimed']=False
result['snapshotPayloadReturned']='--metadata-only' not in sys.argv
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
result['publicUnauthenticatedRoutes']={}
for path in ['/v1/payments/status','/v1/payments/wallet',
             '/v1/payments/history/usage','/v1/payments/history/usage/export.csv',
             '/v1/payments/history/reservations','/v1/payments/history/reservations/export.csv',
             '/v1/payments/history/orders','/v1/payments/history/orders/export.csv',
             '/v1/payments/history/refunds','/v1/payments/history/refunds/export.csv']:
    try:
        with opener.open('https://geod.laogao.xyz'+path,timeout=10) as response:
            status=response.status
    except urllib.error.HTTPError as error:
        status=error.code
        error.close()
    result['publicUnauthenticatedRoutes'][path]=status
print(json.dumps(result,ensure_ascii=False),flush=True)
