"""Save production snapshots privately; print only counts and public observations."""
import argparse
import base64
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SKILL = Path('C:/Users/Administrator/.codex/skills/laogao-tencent-deploy')

parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True,type=Path)
parser.add_argument('--metadata-only',action='store_true')
args=parser.parse_args()
output=args.output.resolve()
if not output.is_relative_to(ROOT/'artifacts') or output.exists():
    raise SystemExit('Use a fresh local artifact directory')
output.mkdir(parents=True,exist_ok=False)
private=output/'private-snapshots'
private.mkdir()
identity=subprocess.check_output(['whoami.exe','/user','/fo','csv','/nh'],text=True,encoding='utf-8')
sid=next(csv.reader(identity.splitlines()))[1]
assert sid.startswith('S-1-5-')
subprocess.run(['icacls.exe',str(private),'/inheritance:r','/grant:r',
                '*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],capture_output=True,check=True)

remote=Path(__file__).with_name('gateway_migration_source.py')
command='python3 -c '+shlex.quote("import base64;exec(compile(base64.b64decode('"+
          base64.b64encode(remote.read_bytes()).decode()+"'),'<readonly migration observation>','exec'))")
if args.metadata_only:
    command+=' --metadata-only'
completed=subprocess.run(['ssh.exe','-i','C:/Users/Administrator/.ssh/laogao_tencent_ed25519',
    '-o','BatchMode=yes','-o','PasswordAuthentication=no','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile='+str(SKILL/'references/known_hosts'),'-o','ConnectTimeout=15',
    'ubuntu@62.234.147.130',command],capture_output=True,timeout=90)
if completed.returncode:
    (private/'ssh-failure.log').write_bytes(completed.stderr)
    (output/'failure.json').write_text(json.dumps({'passed':False,'stage':'readonly SSH observation',
        'exitCode':completed.returncode,'stderrSha256':hashlib.sha256(completed.stderr).hexdigest(),
        'sourceScriptSha256':hashlib.sha256(remote.read_bytes()).hexdigest()}),encoding='utf-8')
    raise SystemExit('Read-only observation failed; no service changes were requested')
observed=json.loads(completed.stdout)
for record in observed['databases']:
    assert record['name'] in {'agent-model.sqlite','agent-model.sqlite-credits.sqlite'}
    if args.metadata_only:
        assert 'snapshotBase64' not in record and not observed['snapshotPayloadReturned']
        continue
    payload=base64.b64decode(record.pop('snapshotBase64'),validate=True)
    assert len(payload)==record['bytes'] and hashlib.sha256(payload).hexdigest()==record['sha256']
    with (private/record['name']).open('xb') as stream:
        stream.write(payload)
observed.update(passed=True,receivedAt=datetime.now(timezone.utc).isoformat(),
                privateSnapshotsAclRestricted=True,sourceScriptSha256=hashlib.sha256(remote.read_bytes()).hexdigest(),
                inspectorScriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
with (output/'production-observation.json').open('x',encoding='utf-8') as file:
    json.dump(observed,file,ensure_ascii=False,indent=2)
print(json.dumps({'passed':True,'productionService':observed['productionService'],
    'databases':[{'name':r['name'],'bytes':r['bytes'],'counts':{k:v['count'] for k,v in r['tables'].items()}}
                 for r in observed['databases']],
    'publicUnauthenticatedRoutes':observed['publicUnauthenticatedRoutes'],
    'remoteFilesCreated':False,'modelRequestsSent':0,'privateSnapshotsAclRestricted':True}),flush=True)
