"""Native desktop acceptance. Reuse the authorized project test key read-only."""
from pathlib import Path
import argparse, json, os, secrets, socket, subprocess, sys, time, urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--existing-geod-config', action='store_true')
parser.add_argument('--remaining-only', action='store_true')
parser.add_argument('--output', default='artifacts/ai-channels-integration-20261004')
parser.add_argument('--litellm-python', default='artifacts/ai-channels-verification-20261003/litellm-venv/Scripts/python.exe')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
folder = (repo / args.output).resolve(); folder.mkdir(parents=True, exist_ok=True)
key = os.environ.get('GEOD_QA_DEEPSEEK_KEY') or os.environ.get('DEEPSEEK_API_KEY')
if not key and args.existing_geod_config:
    skill = Path.home() / '.codex/skills/laogao-tencent-deploy'
    result = subprocess.run(['ssh.exe', '-i', str(Path.home() / '.ssh/laogao_tencent_ed25519'), '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={skill / "references/known_hosts"}', '-o', 'ConnectTimeout=15', 'ubuntu@62.234.147.130', 'sudo cat /srv/laogao/secrets/geod-agent.env'], capture_output=True, encoding='utf-8', timeout=30)
    if result.returncode: raise SystemExit('Existing project credential unavailable; no remote changes made')
    for line in result.stdout.splitlines():
        name, sep, value = line.partition('=')
        if sep and name.strip() == 'DEEPSEEK_API_KEY': key = value.strip().strip('"').strip("'")
    del result
if not key: raise SystemExit('Process-only project test key required')
master = 'sk-native-qa-' + secrets.token_hex(24)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
env = dict(os.environ, DEEPSEEK_API_KEY=key, GEOD_QA_DEEPSEEK_KEY=key, LITELLM_MASTER_KEY=master, GEOD_QA_LITELLM_KEY=master, GEOD_QA_LITELLM_BASE=f'http://127.0.0.1:{port}/v1', LITELLM_LOG='ERROR', LITELLM_TELEMETRY='False', DO_NOT_TRACK='1')
config = folder / 'litellm-config.yaml'
config.write_text('''model_list:
  - model_name: deepseek-flash
    litellm_params:
      model: deepseek/deepseek-flash
      api_key: os.environ/DEEPSEEK_API_KEY
      api_base: https://api.deepseek.com/v1
      thinking: {type: enabled}
litellm_settings:
  drop_params: true
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
''', encoding='utf-8')
flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
proxy = None; exit_code = 1
try:
    with (folder / 'litellm.log').open('wb') as log:
        proxy = subprocess.Popen([str((repo / args.litellm_python).resolve()), '-X', 'utf8', '-m', 'litellm.proxy.proxy_cli', '--config', str(config), '--host', '127.0.0.1', '--port', str(port), '--num_workers', '1', '--telemetry', 'False'], env=env, cwd=repo, stdout=log, stderr=log, stdin=subprocess.DEVNULL, creationflags=flags)
    for _ in range(180):
        if proxy.poll() is not None: raise RuntimeError('Temporary test gateway failed to start')
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/models', headers={'Authorization': f'Bearer {master}'})
            with urllib.request.urlopen(request, timeout=1) as response:
                if response.status == 200: break
        except OSError: time.sleep(.2)
    else: raise RuntimeError('Temporary test gateway did not become ready')
    command = [str(repo / 'apps/geod-agent-desktop/src-tauri/resources/codex/node.exe'), 'apps/geod-agent-desktop/test/ai-channels-integrated.mjs', str(folder)]
    if args.remaining_only: command.append('--remaining-only')
    completed = subprocess.run(command, env=env, cwd=repo, creationflags=flags)
    exit_code = completed.returncode
finally:
    if proxy:
        proxy.terminate()
        try: proxy.wait(timeout=8)
        except subprocess.TimeoutExpired: proxy.kill(); proxy.wait()
    log = folder / 'litellm.log'
    if log.exists():
        value = log.read_text(encoding='utf-8', errors='replace')
        log.write_text(value.replace(key, '[redacted]').replace(master, '[redacted]'), encoding='utf-8')
    roots = [folder, Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/ai-channels', Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/codex-runtime']
    violations = []; checked = 0; unreadable = []
    for root in roots:
        if not root.exists(): continue
        for path in root.rglob('*'):
            if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024: continue
            try: data = path.read_bytes()
            except PermissionError:
                unreadable.append(str(path)); continue
            checked += 1
            if key.encode() in data or master.encode() in data: violations.append(str(path))
    audit = {'passed': not violations, 'filesChecked': checked, 'plaintextCredentialFiles': violations, 'lockedFilesNotScanned': unreadable, 'temporaryProxyStopped': proxy is None or proxy.poll() is not None}
    (folder / 'credential-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
    if violations: exit_code = 1
    print(json.dumps({'exitCode': exit_code, 'credentialAudit': audit, 'output': str(folder)}))
sys.exit(exit_code)
