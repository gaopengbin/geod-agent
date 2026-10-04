"""Run local, real-model channel acceptance with process-only project credentials.

The existing provider configuration is read over pinned SSH only with
--existing-geod-config. No remote configuration, database or service is changed.
"""
from pathlib import Path
import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--existing-geod-config', action='store_true')
parser.add_argument('--route', choices=['direct-flash', 'direct-pro', 'litellm-responses'])
parser.add_argument('--output', default='artifacts/ai-channels-verification-20261003')
parser.add_argument('--litellm-python', default=sys.executable)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
folder = (repo / args.output).resolve()
folder.mkdir(parents=True, exist_ok=True)
environment = dict(os.environ)
key = environment.get('GEOD_QA_DEEPSEEK_KEY') or environment.get('DEEPSEEK_API_KEY')
if not key and args.existing_geod_config:
    skill = Path.home() / '.codex/skills/laogao-tencent-deploy'
    result = subprocess.run(['ssh.exe', '-i', str(Path.home() / '.ssh/laogao_tencent_ed25519'),
        '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes',
        '-o', f'UserKnownHostsFile={skill / "references/known_hosts"}', '-o', 'ConnectTimeout=15',
        'ubuntu@62.234.147.130', 'sudo cat /srv/laogao/secrets/geod-agent.env'],
        capture_output=True, encoding='utf-8', timeout=30)
    if result.returncode:
        raise SystemExit('Existing GeoD project credential could not be read; no remote changes made.')
    for line in result.stdout.splitlines():
        name, sep, value = line.partition('=')
        if sep and name.strip() == 'DEEPSEEK_API_KEY':
            key = value.strip().strip('"').strip("'")
    del result
if not key:
    raise SystemExit('Set GEOD_QA_DEEPSEEK_KEY or use --existing-geod-config.')
environment['GEOD_QA_DEEPSEEK_KEY'] = key
environment['DEEPSEEK_API_KEY'] = key
master = 'sk-geod-qa-' + secrets.token_hex(24)
environment['LITELLM_MASTER_KEY'] = master
environment['GEOD_QA_LITELLM_KEY'] = master
environment['LITELLM_LOG'] = 'ERROR'
environment['LITELLM_TELEMETRY'] = 'False'
environment['DO_NOT_TRACK'] = '1'
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    proxy_port = listener.getsockname()[1]
environment['GEOD_QA_LITELLM_BASE'] = f'http://127.0.0.1:{proxy_port}/v1'
node = repo / 'apps/geod-agent-desktop/src-tauri/resources/codex/node.exe'
proxy = None
flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
try:
    if args.route in [None, 'litellm-responses']:
        config = folder / 'litellm-config.yaml'
        config.write_text('''model_list:
  - model_name: deepseek-flash
    litellm_params:
      model: deepseek/deepseek-flash
      api_key: os.environ/DEEPSEEK_API_KEY
      api_base: https://api.deepseek.com/v1
      thinking: {type: enabled}
  - model_name: deepseek-v4-pro
    litellm_params:
      model: deepseek/deepseek-v4-pro
      api_key: os.environ/DEEPSEEK_API_KEY
      api_base: https://api.deepseek.com/v1
      thinking: {type: enabled}
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
''', encoding='utf-8')
        with (folder / 'litellm.log').open('wb') as log:
            proxy = subprocess.Popen([args.litellm_python, '-X', 'utf8', '-m', 'litellm.proxy.proxy_cli',
                '--config', str(config), '--host', '127.0.0.1', '--port', str(proxy_port), '--num_workers', '1', '--telemetry', 'False'],
                cwd=repo, env=environment, stdout=log, stderr=log, stdin=subprocess.DEVNULL, creationflags=flags)
        for _ in range(180):
            if proxy.poll() is not None:
                raise RuntimeError('LiteLLM failed to start; inspect the sanitized local log.')
            try:
                request = urllib.request.Request(f'http://127.0.0.1:{proxy_port}/v1/models', headers={'Authorization': f'Bearer {master}'})
                with urllib.request.urlopen(request, timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('LiteLLM did not become ready.')
    command = [str(node), 'apps/geod-agent-desktop/test/ai-channels-real.mjs', '--output', str(folder)]
    if args.route:
        command += ['--route', args.route]
    completed = subprocess.run(command, cwd=repo, env=environment, creationflags=flags)
    exit_code = completed.returncode
except RuntimeError as error:
    print(str(error))
    exit_code = 1
finally:
    if proxy:
        proxy.terminate()
        try:
            proxy.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proxy.kill()
            proxy.wait()
    log = folder / 'litellm.log'
    if log.exists():
        text = log.read_text(encoding='utf-8', errors='replace')
        log.write_text(text.replace(key, '[REDACTED]').replace(master, '[REDACTED]'), encoding='utf-8')
    leaked = []
    scanned = 0
    for current, dirs, files in os.walk(folder):
        dirs[:] = [name for name in dirs if name != 'litellm-venv']
        for name in files:
            file = Path(current) / name
            if file.stat().st_size > 32 * 1024 * 1024:
                continue
            content = file.read_bytes()
            scanned += 1
            if key.encode() in content or master.encode() in content:
                leaked.append(str(file.relative_to(folder)))
    audit = {'filesScanned': scanned, 'credentialsPersisted': bool(leaked), 'leakedFiles': leaked, 'proxyStopped': proxy is None or proxy.poll() is not None}
    (folder / 'credential-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(folder), **audit}))
    if leaked:
        exit_code = 1
raise SystemExit(exit_code)
