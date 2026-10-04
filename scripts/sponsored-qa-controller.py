"""Own one isolated sponsored gateway; keep credentials in process memory only."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
import psutil

REPO = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get('GEOD_SPONSOR_QA_ROOT', str(REPO / 'artifacts/product-gaps-20261004/sponsored-channels'))).resolve()
if not ROOT.is_relative_to((REPO / 'artifacts').resolve()):
    raise RuntimeError('Sponsored QA records must stay in repository artifacts')
STATE = ROOT / 'gateway-state.json'
CONTROL = ROOT / 'gateway-control.json'
ACK = ROOT / 'gateway-ack.json'
FLAGS = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

def write(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(file)

def owned(pid, created):
    process = psutil.Process(pid)
    if abs(process.create_time() - created) > .01:
        raise RuntimeError('Recorded QA process identity changed')
    return process

def running_models():
    file = ROOT / 'gateway.sqlite'
    if not file.exists():
        return 0
    with sqlite3.connect(f'file:{file.as_posix()}?mode=ro', uri=True) as database:
        return database.execute("SELECT COUNT(*) FROM model_generations WHERE state IN ('reserved','streaming')").fetchone()[0]

def serve():
    state = json.loads(STATE.read_text(encoding='utf-8'))
    node = os.environ['GEOD_QA_GATEWAY_NODE']
    key = os.environ['DEEPSEEK_API_KEY']
    child = None

    def publish():
        current = json.loads(STATE.read_text(encoding='utf-8'))
        for field in ['controllerPid', 'controllerCreatedAt']:
            if field in current:
                state[field] = current[field]
        write(STATE, state)

    def start():
        nonlocal child
        env = dict(os.environ, GEOD_LOCAL_DESKTOP_TEST='1',
                   GEOD_LOCAL_GATEWAY_PORT=str(state['port']),
                   GEOD_LOCAL_GATEWAY_DB_PATH=str(ROOT / 'gateway.sqlite'),
                   GEOD_AGENT_SPONSORS_JSON=(ROOT / 'sponsors.json').read_text(encoding='utf-8'))
        with (ROOT / 'gateway.log').open('ab') as log:
            child = subprocess.Popen([node, str(REPO / 'services/geod-agent-model-gateway/dev/local-desktop-gateway.mjs')],
                                     cwd=REPO, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, creationflags=FLAGS)
        state.update(gatewayPid=child.pid, gatewayCreatedAt=psutil.Process(child.pid).create_time(), stopped=False)
        publish()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            if child.poll() is not None:
                raise RuntimeError('Isolated QA gateway failed to start; inspect redacted log')
            try:
                with opener.open(f"http://127.0.0.1:{state['port']}/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(.2)
        raise RuntimeError('Isolated QA gateway did not become healthy')

    def stop():
        nonlocal child
        if child and child.poll() is None:
            owned(child.pid, state['gatewayCreatedAt'])
            if running_models():
                raise RuntimeError('Actual model still active; refusing gateway restart or stop')
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    try:
        start()
        state['ready'] = True
        publish()
        last = None
        while True:
            if child.poll() is not None:
                raise RuntimeError('Isolated QA gateway exited unexpectedly')
            if CONTROL.exists():
                command = json.loads(CONTROL.read_text(encoding='utf-8'))
                if command['operationId'] != last:
                    last = command['operationId']
                    try:
                        if command['action'] not in ['restart', 'stop']:
                            raise RuntimeError('Unsupported QA control')
                        stop()
                        if command['action'] == 'restart':
                            start()
                        write(ACK, dict(operationId=last, passed=True, action=command['action']))
                        if command['action'] == 'stop':
                            break
                    except RuntimeError as error:
                        write(ACK, dict(operationId=last, passed=False, error=str(error)))
            time.sleep(.2)
    finally:
        if child and child.poll() is None and not running_models():
            stop()
        for file in [ROOT / 'gateway.log', ROOT / 'controller.log']:
            if file.exists():
                content = file.read_text(encoding='utf-8', errors='replace')
                file.write_text(content.replace(key, '[redacted]').replace(os.environ['GEOD_LOCAL_GATEWAY_SECRET'], '[redacted]'), encoding='utf-8')
        state.update(ready=False, stopped=True)
        publish()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['start', 'serve', 'desktop', 'restart', 'stop', 'ledger', 'audit'])
    parser.add_argument('--scoped', action='store_true', help='Check owned acceptance records, exact backup and channel cache')
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    if args.mode == 'serve':
        serve()
        return
    if args.mode == 'start':
        if STATE.exists():
            raise RuntimeError('Inspect the existing sponsored QA state before another run')
        original_pid = int((Path(os.environ['LOCALAPPDATA']) / 'GeoD Agent/dev-logs/local-gateway.pid').read_text().strip())
        original = psutil.Process(original_pid)
        command = original.cmdline()
        if not any(value.endswith('local-desktop-gateway.mjs') for value in command):
            raise RuntimeError('Existing project test gateway identity mismatch')
        key = original.environ().get('DEEPSEEK_API_KEY')
        if not key:
            raise RuntimeError('Authorized project test credential unavailable')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        model = dict(id='deepseek-flash', name='DeepSeek Flash', contextWindow=128000,
                     maxOutputTokens=4096, inputModalities=['text'], thinking='enabled')
        common = dict(baseUrl='https://api.deepseek.com/v1', apiKeyEnv='DEEPSEEK_API_KEY',
                      models=[model], allowedUsers=['local-desktop-test'])
        providers = [dict(common, id='qa-sponsored', name='GeoD 赞助渠道验收',
                          description='独立测试渠道 · 真实模型调用', website='https://api-docs.deepseek.com', quotaMode='observe'),
                     dict(common, id='qa-limited', name='赞助额度边界验收', quotaMode='enforced', perUserTokenLimit=32, totalTokenLimit=32),
                     dict(common, id='qa-disabled', name='已停用赞助验收', enabled=False),
                     dict(common, id='qa-hidden', name='其他账号专属验收', allowedUsers=['different-qa-account'])]
        if os.environ.get('GEOD_SPONSOR_QA_BUDGET_PERIOD') == 'month':
            providers = [dict(provider, budgetPeriod='month') for provider in providers]
        write(ROOT / 'sponsors.json', providers)
        write(STATE, dict(port=port, ready=False, stopped=False, originalGatewayPid=original_pid,
                          originalGatewayCreatedAt=original.create_time()))
        env = dict(os.environ, DEEPSEEK_API_KEY=key,
                   GEOD_LOCAL_GATEWAY_SECRET=secrets.token_hex(32), GEOD_QA_GATEWAY_NODE=command[0])
        with (ROOT / 'controller.log').open('ab') as log:
            process = subprocess.Popen([sys.executable, '-X', 'utf8', str(Path(__file__).resolve()), 'serve'],
                                       cwd=REPO, env=env, stdin=subprocess.DEVNULL, stdout=log,
                                       stderr=log, creationflags=FLAGS)
        for _ in range(150):
            state = json.loads(STATE.read_text(encoding='utf-8'))
            if state['ready']:
                state.update(controllerPid=process.pid, controllerCreatedAt=psutil.Process(process.pid).create_time())
                write(STATE, state)
                print(json.dumps(dict(ready=True, port=port, originalGatewayPreserved=original.is_running())))
                return
            if process.poll() is not None:
                raise RuntimeError('QA controller failed; inspect its redacted log')
            time.sleep(.2)
        raise RuntimeError('QA controller readiness timeout')
    state = json.loads(STATE.read_text(encoding='utf-8'))
    if args.mode == 'desktop':
        if not state['ready']:
            raise RuntimeError('Start the owned gateway before the development desktop')
        env = dict(os.environ, GEOD_AGENT_DEV_GATEWAY_ORIGIN=f"http://127.0.0.1:{state['port']}")
        env.pop('DEEPSEEK_API_KEY', None)
        env.pop('GEOD_LOCAL_GATEWAY_SECRET', None)
        subprocess.run([sys.executable, '-X', 'utf8', 'scripts/start-codex-dev.py'], cwd=REPO, env=env,
                       creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    elif args.mode in ['restart', 'stop']:
        controller = owned(state['controllerPid'], state['controllerCreatedAt'])
        operation = secrets.token_hex(16)
        write(CONTROL, dict(action=args.mode, operationId=operation))
        for _ in range(150):
            if ACK.exists():
                ack = json.loads(ACK.read_text(encoding='utf-8'))
                if ack['operationId'] == operation:
                    if not ack['passed']:
                        raise RuntimeError(ack['error'])
                    if args.mode == 'restart':
                        refreshed = json.loads(STATE.read_text(encoding='utf-8'))
                        refreshed.update(controllerPid=state['controllerPid'], controllerCreatedAt=state['controllerCreatedAt'])
                        write(STATE, refreshed)
                    if args.mode == 'stop':
                        try:
                            controller.wait(timeout=10)
                        except psutil.TimeoutExpired:
                            raise RuntimeError('QA controller did not stop')
                    print(json.dumps(ack))
                    return
            time.sleep(.2)
        raise RuntimeError('QA control acknowledgment timeout')
    elif args.mode == 'ledger':
        with sqlite3.connect(f"file:{(ROOT / 'gateway.sqlite').as_posix()}?mode=ro", uri=True) as database:
            database.row_factory = sqlite3.Row
            rows = [dict(row) for row in database.execute('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at')]
        report = dict(rows=rows, actualTokens=sum((r['input_tokens'] or 0)+(r['output_tokens'] or 0) for r in rows if r['state'] == 'settled'))
        write(ROOT / 'actual-server-ledger.json', report)
        print(json.dumps(dict(generations=len(rows), actualTokens=report['actualTokens'], active=running_models())))
    elif args.mode == 'audit':
        controller = owned(state['controllerPid'], state['controllerCreatedAt'])
        key = controller.environ()['DEEPSEEK_API_KEY'].encode()
        violations = []
        checked = 0
        roots = [ROOT, Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/ai-channels', Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/codex-runtime']
        acceptance = ROOT / 'restart-state.json'
        backup = None
        if acceptance.exists():
            acceptance_state = json.loads(acceptance.read_text(encoding='utf-8'))
            backup = acceptance_state.get('backup')
            if backup:
                roots.append(Path(backup['path']))
            if args.scoped:
                roots.pop(2)
                user_hash = hashlib.sha256(acceptance_state['userId'].encode()).hexdigest()
                thread_hash = hashlib.sha256(acceptance_state['conversationId'].encode()).hexdigest()[:16]
                roots.append(Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/codex-runtime'/('account-'+user_hash)/('conversation-'+thread_hash))
        for root in roots:
            if not root.exists():
                continue
            for file in root.rglob('*'):
                if not file.is_file() or file.stat().st_size > 64 * 1024 * 1024:
                    continue
                checked += 1
                if key in file.read_bytes():
                    violations.append(str(file))
        desktop = [p for p in psutil.process_iter(['name']) if p.info['name'] == 'geod-agent-desktop.exe']
        desktop_key_present = any(key.decode() in p.environ().values() for p in desktop)
        report = dict(passed=not violations and not desktop_key_present, filesChecked=checked,
                      plaintextCredentialFiles=violations, desktopProviderKeyPresent=desktop_key_present,
                      desktopInstances=len(desktop), scoped=args.scoped, includesExactBackup=bool(backup))
        write(ROOT/'credential-audit.json', report)
        print(json.dumps(report))
        if not report['passed']:
            raise RuntimeError('Sponsor credential audit failed')

if __name__ == '__main__':
    main()
