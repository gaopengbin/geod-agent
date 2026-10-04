"""Normal exit/restart evidence for the development app, preserving the gateway."""
from pathlib import Path
import argparse,json,time,psutil
parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['before','stopped','after','final']);parser.add_argument('--label',default='recovery');args=parser.parse_args()
root=Path('artifacts/product-gaps-20261004/encrypted-documents').resolve()
assert args.label in ['runtime-refresh','recovery']
file=root/(args.label+'-processes.json')
gateway_state=json.loads(Path('artifacts/product-gaps-20261004/sponsored-months/gateway-state.json').read_text(encoding='utf-8'))
gateway=psutil.Process(gateway_state['originalGatewayPid']);assert abs(gateway.create_time()-gateway_state['originalGatewayCreatedAt'])<.01 and gateway.is_running()
expected=(Path.cwd()/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve()
def instances():
    rows=[]
    for p in psutil.process_iter(['name']):
        if p.info['name']=='geod-agent-desktop.exe' and Path(p.exe()).resolve()==expected:
            rows.append(dict(pid=p.pid,createdAt=p.create_time(),background='--background-runtime' in p.cmdline()))
    return rows
if args.mode=='final':
    rows=instances();assert len(rows)==2
    provider_key=gateway.environ().get('DEEPSEEK_API_KEY');assert provider_key
    for row in rows:
        env=psutil.Process(row['pid']).environ();row['providerKeyInEnvironment']=provider_key in env.values();row['gatewayOrigin']=env.get('GEOD_AGENT_DEV_GATEWAY_ORIGIN');assert not row['providerKeyInEnvironment'] and row['gatewayOrigin']=='http://127.0.0.1:43123'
    report=dict(passed=True,originalGatewayPreserved=True,developmentInstances=rows)
    (root/'final-environment.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report));raise SystemExit(0)
if args.mode=='before':
    assert not file.exists(),'Preserve recorded process identities'
    rows=instances();assert len(rows)==2
    descendants=[]
    for row in rows:
        for child in psutil.Process(row['pid']).children(recursive=True):descendants.append(dict(pid=child.pid,createdAt=child.create_time(),name=child.name()))
    report=dict(before=rows,descendants=descendants,originalGatewayPreserved=True)
else:
    report=json.loads(file.read_text(encoding='utf-8'));deadline=time.monotonic()+30
    while True:
        remaining=[]
        for row in report['before']+report['descendants']:
            try:
                p=psutil.Process(row['pid'])
                if abs(p.create_time()-row['createdAt'])<.01 and p.is_running():remaining.append(row['pid'])
            except psutil.NoSuchProcess:pass
        if not remaining:break
        if time.monotonic()>deadline:raise RuntimeError('Recorded app descendants did not exit: '+str(remaining))
        time.sleep(.25)
    report['oldProcessesExited']=True
    if args.mode=='after':
        until=time.monotonic()+30
        rows=instances()
        while len(rows)<2 and time.monotonic()<until:time.sleep(.25);rows=instances()
        assert len(rows)==2;report['after']=rows;report['passed']=True
file.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(dict(mode=args.mode,originalGatewayPreserved=True,oldProcessesExited=report.get('oldProcessesExited',False))))
