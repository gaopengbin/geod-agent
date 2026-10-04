"""Retain the local candidate gates without touching real payment state."""
from pathlib import Path
import datetime, hashlib, json, re, subprocess
import psutil

repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/payments'
desktop=repo/'apps/geod-agent-desktop'
def read(path):return json.loads(path.read_text(encoding='utf-8'))
gateway=read(root/'acceptance.json')
assert gateway['passed'] and gateway['gatewayCases']>=62 and gateway['paymentCases']==14
baseline=read(repo/'artifacts/product-gaps-20261004/sponsored-months/gateway-state.json')
original=psutil.Process(baseline['originalGatewayPid'])
assert abs(original.create_time()-baseline['originalGatewayCreatedAt'])<.01

phases=['native-ui/initial-acceptance.json','native-ui/restarted-acceptance.json',
        'native-ui/settlement-acceptance.json','native-ui/visual-pass/visual-acceptance.json',
        'native-ui/usage-pass/usage-acceptance.json','native-ui/retry-pass/retry-acceptance.json',
        'native-ui/retry-pass/restore-acceptance.json']
phase_records=[]
for name in phases:
    value=read(root/name)
    assert value['passed'] and value['actualNative'] and not value['realPayments'] and not value['realRefunds']
    assert all(check['passed'] for check in value['checks'])
    phase_records.append({'path':name,'checks':len(value['checks']),
                          'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()})
profile=read(root/'original-profile-preserved.json')
assert profile['passed'] and profile['originalConversations']==30 and profile['originalConnectionCount']==4
environment=read(root/'native-ui/retry-pass/final-environment.json')
assert environment['passed'] and environment['fixtureStopped'] and environment['originalGatewayPreserved']
for sub in ['native-ui','native-ui/visual-pass','native-ui/usage-pass','native-ui/retry-pass']:
    owner=read(root/sub/'process-owner.json')
    try:assert abs(psutil.Process(owner['pid']).create_time()-owner['createdAt'])>.01
    except psutil.NoSuchProcess:pass
native=[]
for process in psutil.process_iter(['name']):
    if process.info['name']=='geod-agent-desktop.exe' and Path(process.exe()).resolve()==(desktop/'src-tauri/target/debug/geod-agent-desktop.exe').resolve():
        env=process.environ()
        assert env.get('GEOD_AGENT_DEV_GATEWAY_ORIGIN')=='http://127.0.0.1:43123' and 'DEEPSEEK_API_KEY' not in env
        native.append({'pid':process.pid,'createdAt':process.create_time(),'background':'--background-runtime' in process.cmdline()})
assert len(native)==2
gates=[]
previous=read(root/'desktop-candidate-acceptance.json') if (root/'desktop-candidate-acceptance.json').exists() else None
for label,command,cwd in [
    ('frontend-build',['npm.cmd','run','build'],desktop),
    ('native-services',['cargo','test','--lib','services::tests'],desktop/'src-tauri')]:
    native_files=['apps/geod-agent-desktop/src-tauri/src/services.rs','apps/geod-agent-desktop/src-tauri/src/lib.rs']
    if label=='native-services' and previous and all(previous['sourceSha256'].get(name)==hashlib.sha256((repo/name).read_bytes()).hexdigest() for name in native_files):
        retained=next(gate for gate in previous['gates'] if gate['name']==label)
        assert retained['passed'] and retained['cases']>=12 and (root/(label+'.log')).exists()
        gates.append({**retained,'retainedForUnchangedSource':True})
        continue
    result=subprocess.run(command,cwd=cwd,capture_output=True,encoding='utf-8',errors='strict')
    (root/(label+'.log')).write_text(result.stdout+result.stderr,encoding='utf-8')
    assert result.returncode==0,f'{label} failed; inspect retained log'
    gate={'name':label,'passed':True}
    if label=='native-services':
        match=re.search(r'test result: ok\. (\d+) passed; 0 failed',result.stdout)
        assert match and int(match.group(1))>=12
        gate['cases']=int(match.group(1))
    gates.append(gate)
files=[
    'services/geod-agent-model-gateway/server.mjs',
    'services/geod-agent-model-gateway/payment-host-candidate.mjs',
    'services/geod-agent-model-gateway/payment-ledger-candidate.mjs',
    'services/geod-agent-model-gateway/payment-http-candidate.mjs',
    'services/geod-agent-model-gateway/alipay-payment-candidate.mjs',
    'services/geod-agent-model-gateway/pricing-candidate.mjs',
    'services/geod-agent-model-gateway/payment-config.example.json',
    'apps/geod-agent-desktop/src/payment-dialog.tsx',
    'apps/geod-agent-desktop/src/payment-dialog.css',
    'apps/geod-agent-desktop/src/api.ts',
    'apps/geod-agent-desktop/src/app.tsx',
    'apps/geod-agent-desktop/src/locales/en.json',
    'apps/geod-agent-desktop/src-tauri/src/services.rs',
    'apps/geod-agent-desktop/src-tauri/src/lib.rs']
for name,digest in gateway['files'].items():
    assert hashlib.sha256((repo/'services/geod-agent-model-gateway'/name).read_bytes()).hexdigest()==digest
assert abs(psutil.Process(original.pid).create_time()-baseline['originalGatewayCreatedAt'])<.01
report={'passed':True,'candidateOnly':True,'realPayment':False,'realRefund':False,'realModelPaymentTest':False,
        'published':False,'installed':False,'testAllowanceUnlimited':True,'gatewayCases':gateway['gatewayCases'],
        'paymentCases':gateway['paymentCases'],'paymentHostCases':gateway['paymentHostCases'],
        'nativeUiChecks':sum(item['checks'] for item in phase_records),'phases':phase_records,'gates':gates,
        'originalProfile':profile,'originalGatewayPreserved':True,'fixturesStopped':True,'developmentInstances':native,
        'sourceSha256':{name:hashlib.sha256((repo/name).read_bytes()).hexdigest() for name in files},
        'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(root/'desktop-candidate-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({key:value for key,value in report.items() if key not in ['sourceSha256','phases','originalProfile','developmentInstances']},ensure_ascii=False))
