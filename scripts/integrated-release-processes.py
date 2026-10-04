"""Record normal isolated-candidate lifecycle; never stop the user's gateway."""
from pathlib import Path
import argparse
import json
import psutil
import time

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('label')
parser.add_argument('mode', choices=['before-dev', 'before-release', 'stopped', 'after-dev', 'environment'])
args = parser.parse_args()
output = Path(args.output).resolve()
assert output.is_relative_to(repo/'artifacts') and output.name.startswith('release-candidate-')
assert args.label in ['isolation', 'candidate-restart', 'candidate-cleanup']
file = output/(args.label+'-processes.json')
gateway_state = json.loads((repo/'artifacts/product-gaps-20261004/sponsored-months/gateway-state.json').read_text(encoding='utf-8'))
gateway = psutil.Process(gateway_state['originalGatewayPid'])
assert abs(gateway.create_time()-gateway_state['originalGatewayCreatedAt']) < .01 and gateway.is_running()
development = (repo/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve()
candidate = json.loads((output/'candidate.json').read_text(encoding='utf-8'))
release = (output/f"GeoD-Agent-{candidate['version']}-windows-x64/geod-agent-desktop.exe").resolve()
def instances(executable):
    return [dict(pid=p.pid, createdAt=p.create_time(), background='--background-runtime' in p.cmdline())
            for p in psutil.process_iter(['name'])
            if p.info['name'] == 'geod-agent-desktop.exe' and Path(p.exe()).resolve() == executable]
if args.mode.startswith('before-'):
    assert not file.exists(), 'Preserve the recorded lifecycle'
    rows = instances(development if args.mode == 'before-dev' else release)
    assert len(rows) == 2
    children = []
    for row in rows:
        children.extend(dict(pid=c.pid, createdAt=c.create_time(), name=c.name()) for c in psutil.Process(row['pid']).children(recursive=True))
    report = dict(before=rows, descendants=children, originalGatewayPreserved=True)
elif args.mode == 'environment':
    rows = instances(release)
    assert len(rows) == 2
    key = gateway.environ().get('DEEPSEEK_API_KEY')
    assert key
    for row in rows:
        env = psutil.Process(row['pid']).environ()
        row['gatewayOrigin'] = env.get('GEOD_AGENT_GATEWAY_ORIGIN')
        row['providerKeyInEnvironment'] = key in env.values()
        row['stockWindowsPath'] = all('code' not in part.lower() and 'python' not in part.lower() and 'node' not in part.lower() for part in env['PATH'].split(';'))
        assert row['gatewayOrigin'] == 'http://127.0.0.1:43123' and not row['providerKeyInEnvironment'] and row['stockWindowsPath']
    report = dict(passed=True, instances=rows, originalGatewayPreserved=True)
    file = output/'integrated-environment.json'
else:
    report = json.loads(file.read_text(encoding='utf-8'))
    deadline = time.monotonic()+30
    while True:
        remaining = []
        for row in report['before']+report['descendants']:
            try:
                process = psutil.Process(row['pid'])
                if abs(process.create_time()-row['createdAt']) < .01 and process.is_running():
                    remaining.append(row['pid'])
            except psutil.NoSuchProcess:
                pass
        if not remaining:
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Recorded processes did not exit normally: '+str(remaining))
        time.sleep(.25)
    report['oldProcessesExited'] = True
    if args.mode == 'after-dev':
        rows = instances(development)
        assert len(rows) == 2
        report['after'] = rows
    report['passed'] = True
file.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(dict(mode=args.mode, originalGatewayPreserved=True, passed=report.get('passed', False))), flush=True)
