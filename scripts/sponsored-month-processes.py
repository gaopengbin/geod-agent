"""Record and verify normal shutdown of only this acceptance's native processes."""
from pathlib import Path
import argparse
import json
import time
import psutil

root=Path('artifacts/product-gaps-20261004/sponsored-months').resolve()
parser=argparse.ArgumentParser()
parser.add_argument('mode',choices=['before','stopped','after','final'])
args=parser.parse_args()
file=root/'restart-processes.json'
expected=(Path.cwd()/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve()
gateway=json.loads((root/'gateway-state.json').read_text(encoding='utf-8'))
original=psutil.Process(gateway['originalGatewayPid'])
assert abs(original.create_time()-gateway['originalGatewayCreatedAt'])<.01
assert original.is_running()
def native():
    rows=[]
    for p in psutil.process_iter(['name']):
        if p.info['name']=='geod-agent-desktop.exe' and Path(p.exe()).resolve()==expected:
            rows.append(dict(pid=p.pid,createdAt=p.create_time(),background='--background-runtime' in p.cmdline()))
    return rows
if args.mode=='final':
    key=original.environ().get('DEEPSEEK_API_KEY')
    assert key,'Original authorized provider is unavailable'
    rows=native()
    assert len(rows)==2
    for row in rows:
        env=psutil.Process(row['pid']).environ()
        row['gatewayOrigin']=env.get('GEOD_AGENT_DEV_GATEWAY_ORIGIN')
        row['providerKeyPresent']=key in env.values()
        assert row['gatewayOrigin']=='http://127.0.0.1:43123'
        assert not row['providerKeyPresent']
    stopped=[]
    for name in ['controller','gateway']:
        try:
            p=psutil.Process(gateway[name+'Pid'])
            gone=abs(p.create_time()-gateway[name+'CreatedAt'])>.01 or not p.is_running()
        except psutil.NoSuchProcess:
            gone=True
        assert gone,'Owned acceptance helper is still running'
        stopped.append(dict(process=name,ownedProcessStopped=gone))
    result=dict(passed=True,originalGatewayPreserved=True,qaStopped=stopped,developmentInstances=rows)
    (root/'final-environment.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)
    raise SystemExit(0)
if args.mode=='before':
    assert not file.exists(),'Do not overwrite native process evidence'
    rows=native()
    assert len(rows)==2
    descendants=[]
    for row in rows:
        for child in psutil.Process(row['pid']).children(recursive=True):
            descendants.append(dict(pid=child.pid,createdAt=child.create_time(),name=child.name()))
    result=dict(before=rows,descendants=descendants,originalGatewayPreserved=True)
else:
    result=json.loads(file.read_text(encoding='utf-8'))
    deadline=time.monotonic()+30
    while True:
        remaining=[]
        for row in result['before']+result['descendants']:
            try:
                p=psutil.Process(row['pid'])
                if abs(p.create_time()-row['createdAt'])<.01 and p.is_running():
                    remaining.append(row['pid'])
            except psutil.NoSuchProcess:
                pass
        if not remaining: break
        if time.monotonic()>deadline: raise RuntimeError('Owned native processes did not exit normally: '+str(remaining))
        time.sleep(.25)
    result['oldProcessesExited']=True
    if args.mode=='after':
        result['after']=native()
        assert len(result['after'])==2
        for row in result['after']:
            env=psutil.Process(row['pid']).environ()
            assert env.get('GEOD_AGENT_DEV_GATEWAY_ORIGIN')==f"http://127.0.0.1:{gateway['port']}"
        result['passed']=True
file.write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(dict(mode=args.mode,originalGatewayPreserved=True,oldProcessesExited=result.get('oldProcessesExited',False))),flush=True)
