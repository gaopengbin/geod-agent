"""Own one local generated-key fixture; preserve the real development gateway."""
from pathlib import Path
import argparse,json,os,subprocess,sys,time,secrets,shutil
import psutil

repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['start','desktop','control','processes','final']);parser.add_argument('--action');parser.add_argument('--order-id');parser.add_argument('--value');parser.add_argument('--stage');group=parser.add_mutually_exclusive_group();group.add_argument('--visual',action='store_true');group.add_argument('--usage',action='store_true');group.add_argument('--retry',action='store_true');args=parser.parse_args()
root=repo/'artifacts/product-gaps-20261004/payments/native-ui'
if args.visual:root=root/'visual-pass'
if args.usage:root=root/'usage-pass'
if args.retry:root=root/'retry-pass'
root.mkdir(parents=True,exist_ok=True)
baseline=json.loads((repo/'artifacts/product-gaps-20261004/sponsored-months/gateway-state.json').read_text(encoding='utf-8'))
original=psutil.Process(baseline['originalGatewayPid'])
assert original.is_running() and abs(original.create_time()-baseline['originalGatewayCreatedAt'])<.01
state_file=root/'gateway-state.json';owner_file=root/'process-owner.json'
def write(file,value):
    temp=file.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(file)
def owned():
    owner=json.loads(owner_file.read_text(encoding='utf-8'));p=psutil.Process(owner['pid'])
    assert abs(p.create_time()-owner['createdAt'])<.01
    assert any(item.endswith('payment-desktop-fixture.mjs') for item in p.cmdline())
    return p
if args.mode=='start':
    assert not state_file.exists(),'Inspect the existing fixture before another run'
    env={k:v for k,v in os.environ.items() if not k.startswith(('GEOD_','DEEPSEEK_'))}
    env.update(GEOD_PAYMENT_UI_FIXTURE='1',GEOD_PAYMENT_UI_ROOT=str(root))
    # Match the gateway's installed native SQLite ABI. The desktop's bundled
    # Codex Node runtime is a separate, pinned runtime and is not interchangeable.
    node=shutil.which('node');assert node
    with (root/'fixture.log').open('ab') as log:
        p=subprocess.Popen([str(node),str(repo/'services/geod-agent-model-gateway/dev/payment-desktop-fixture.mjs')],cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
    write(owner_file,{'pid':p.pid,'createdAt':psutil.Process(p.pid).create_time(),'providerSecretsUsed':False})
    for _ in range(100):
        if state_file.exists() and json.loads(state_file.read_text(encoding='utf-8'))['ready']:break
        assert p.poll() is None,'Fixture exited; inspect its non-secret log'
        time.sleep(.2)
    else:raise RuntimeError('Fixture readiness timeout')
    print(json.dumps({'ready':True,'fixture':True,'port':json.loads(state_file.read_text(encoding='utf-8'))['port'],'originalGatewayPreserved':True}))
elif args.mode=='desktop':
    owned();state=json.loads(state_file.read_text(encoding='utf-8'));assert state['ready']
    env=dict(os.environ,GEOD_AGENT_DEV_GATEWAY_ORIGIN=f"http://127.0.0.1:{state['port']}")
    env.pop('DEEPSEEK_API_KEY',None);env.pop('GEOD_LOCAL_GATEWAY_SECRET',None)
    subprocess.run([sys.executable,'-X','utf8',str(repo/'scripts/start-codex-dev.py')],cwd=repo,env=env,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
elif args.mode=='control':
    p=owned();assert args.action in ['paid','refundLost','refundNormal','closeMode','modelMode','restart','snapshot','stop']
    op=secrets.token_hex(16);write(root/'gateway-control.json',{'operationId':op,'action':args.action,'orderId':args.order_id,'value':args.value})
    for _ in range(150):
        ack_file=root/'gateway-ack.json'
        if ack_file.exists():
            ack=json.loads(ack_file.read_text(encoding='utf-8'))
            if ack['operationId']==op:
                assert ack['passed'],ack.get('error')
                if args.action=='stop':p.wait(timeout=10)
                print(json.dumps(ack));break
        time.sleep(.2)
    else:raise RuntimeError('Fixture control timeout')
elif args.mode=='processes':
    assert args.stage in ['before-settlement-restart','after-settlement-restart','restored']
    executable=(repo/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve();rows=[]
    for _ in range(60):
        rows=[]
        for p in psutil.process_iter(['name']):
            if p.info['name']=='geod-agent-desktop.exe' and Path(p.exe()).resolve()==executable:
                rows.append({'pid':p.pid,'createdAt':p.create_time(),'background':'--background-runtime' in p.cmdline(),'gateway':p.environ().get('GEOD_AGENT_DEV_GATEWAY_ORIGIN')})
        if len(rows)==2:break
        time.sleep(.2)
    assert len(rows)==2
    if args.stage=='after-settlement-restart':
        before=json.loads((root/'before-settlement-restart.json').read_text(encoding='utf-8'))
        for old in before['native']:
            try:assert abs(psutil.Process(old['pid']).create_time()-old['createdAt'])>.01
            except psutil.NoSuchProcess:pass
        assert all(row['gateway']==f"http://127.0.0.1:{json.loads(state_file.read_text(encoding='utf-8'))['port']}" for row in rows)
    write(root/(args.stage+'.json'),{'passed':True,'native':rows,'originalGatewayPreserved':True})
    print(json.dumps({'passed':True,'stage':args.stage,'native':rows}))
else:
    owner=json.loads(owner_file.read_text(encoding='utf-8'));stopped=True
    try:stopped=not(psutil.Process(owner['pid']).is_running() and abs(psutil.Process(owner['pid']).create_time()-owner['createdAt'])<.01)
    except psutil.NoSuchProcess:pass
    assert stopped
    executable=(repo/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve();native=[]
    for p in psutil.process_iter(['name']):
        if p.info['name']=='geod-agent-desktop.exe' and Path(p.exe()).resolve()==executable:
            env=p.environ();assert env.get('GEOD_AGENT_DEV_GATEWAY_ORIGIN')=='http://127.0.0.1:43123';assert 'DEEPSEEK_API_KEY' not in env
            native.append({'pid':p.pid,'background':'--background-runtime' in p.cmdline(),'gatewayRestored':True})
    assert len(native)==2
    result={'passed':True,'fixtureStopped':True,'originalGatewayPreserved':True,'developmentInstances':native,'realPayment':False,'realRefund':False}
    write(root/'final-environment.json',result);print(json.dumps(result))
