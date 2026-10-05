"""Run real old/new Linux archives against a private copy of production snapshots."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

ROOT=Path(__file__).resolve().parents[1]
IMAGE='sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844'
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()
parser=argparse.ArgumentParser()
parser.add_argument('--source',required=True,type=Path)
parser.add_argument('--old-archive',required=True,type=Path)
parser.add_argument('--new-archive',required=True,type=Path)
parser.add_argument('--output',required=True,type=Path)
args=parser.parse_args()
source,old,new,output=[p.resolve() for p in [args.source,args.old_archive,args.new_archive,args.output]]
assert source.is_relative_to(ROOT/'artifacts') and output.is_relative_to(ROOT/'artifacts') and not output.exists()
observed=json.loads((source/'production-observation.json').read_text(encoding='utf-8'))
assert observed['passed'] and observed['readonly'] and observed['privateSnapshotsAclRestricted']
assert sha(old)=='c90df9dec46c8e9d9b2c694bb2392558d7302c4de16826f2a839bbee40b26f62'
assert sha(new)=='4fbf9b4367cb6d79dad94f1e5695aec2fb009d08ad8b1d1db7966501db58a72c'
for entry in observed['databases']:
    assert sha(source/'private-snapshots'/entry['name'])==entry['sha256']
subprocess.run(['docker.exe','image','inspect',IMAGE],capture_output=True,check=True)
output.mkdir(parents=True,exist_ok=False)
script=Path(__file__).with_suffix('.mjs')
container='geod-history-migration-'+uuid.uuid4().hex[:12]
command=['docker.exe','run','--rm','--pull','never','--network','none','--name',container,
 '--label','geod.test.role=payment-history-migration',
 '-v',str(old)+':/inputs/old.tar.gz:ro','-v',str(new)+':/inputs/new.tar.gz:ro',
 '-v',str(source/'private-snapshots')+':/inputs/snapshots:ro',
 '-v',str(script)+':/inputs/verify.mjs:ro',IMAGE,'node','/inputs/verify.mjs']
try:
    completed=subprocess.run(command,capture_output=True,timeout=90)
except subprocess.TimeoutExpired as error:
    completed=subprocess.CompletedProcess(command,124,error.stdout or b'',error.stderr or b'')
finally:
    # A timed-out Docker CLI does not prove its container stopped. Inspect only
    # the exact random name and refuse cleanup unless its ownership label matches.
    inspected=subprocess.run(['docker.exe','container','inspect',container],capture_output=True)
    if inspected.returncode==0:
        owned=json.loads(inspected.stdout)[0]
        assert owned['Name']=='/'+container and owned['Config']['Labels'].get('geod.test.role')=='payment-history-migration'
        subprocess.run(['docker.exe','stop','-t','5',container],capture_output=True,check=True)
        subprocess.run(['docker.exe','rm',container],capture_output=True) # --rm may already have removed it.
for entry in observed['databases']:
    assert sha(source/'private-snapshots'/entry['name'])==entry['sha256']
containers=subprocess.check_output(['docker.exe','ps','-a','--filter','name=^/'+container+'$',
                                    '--format','{{.Names}}'],text=True).strip()
assert not containers
(output/'stderr.log').write_bytes(completed.stderr)
if completed.returncode:
    (output/'result.json').write_text(json.dumps({'passed':False,'exitCode':completed.returncode,
       'stage':'actual archive migration','dockerContainer':container,'scriptSha256':sha(script),
       'sourceSnapshotsPreserved':True,'testContainerRemoved':True},indent=2),encoding='utf-8')
    raise SystemExit('Migration rehearsal failed; existing evidence retained')
result=json.loads(completed.stdout)
result.update(at=datetime.now(timezone.utc).isoformat(),sourceObservation=str(source/'production-observation.json'),
              oldArchiveSha256=sha(old),newArchiveSha256=sha(new),image=IMAGE,scriptSha256=sha(script),
              runnerScriptSha256=sha(Path(__file__)))
for entry in observed['databases']:
    assert sha(source/'private-snapshots'/entry['name'])==entry['sha256']
result['sourceSnapshotsPreserved']=True
result['testContainerRemoved']=True
(output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:result[k] for k in ['passed','retainedModelRequests','retainedTokenEntries','originalGrants',
     'balancePreserved','legacyRowsPreserved','sourceSnapshotsPreserved','testContainerRemoved','productionModified','publicNetworkUsed']}),flush=True)
