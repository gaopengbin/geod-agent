"""Run local startup acceptance with an existing authorized provider key in memory."""
from pathlib import Path
import argparse, json, os, subprocess, sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--existing-geod-config', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
key = os.environ.get('GEOD_QA_DEEPSEEK_KEY') or os.environ.get('DEEPSEEK_API_KEY')
if not key and args.existing_geod_config:
    skill = Path.home() / '.codex/skills/laogao-tencent-deploy'
    result = subprocess.run(['ssh.exe', '-i', str(Path.home() / '.ssh/laogao_tencent_ed25519'), '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={skill / "references/known_hosts"}', '-o', 'ConnectTimeout=15', 'ubuntu@62.234.147.130', 'sudo cat /srv/laogao/secrets/geod-agent.env'], capture_output=True, encoding='utf-8', timeout=30)
    if result.returncode: raise SystemExit('Existing project test credential unavailable; no remote changes made')
    for line in result.stdout.splitlines():
        name, sep, value = line.partition('=')
        if sep and name.strip() == 'DEEPSEEK_API_KEY': key = value.strip().strip('"').strip("'")
    del result
if not key: raise SystemExit('An authorized process-only test key is required')
env = dict(os.environ, GEOD_QA_DEEPSEEK_KEY=key)
started_at = time.time()
flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
runtime = repo / 'apps/geod-agent-desktop/src-tauri/resources/codex/node.exe'
completed = subprocess.run([str(runtime), 'scripts/verify-byok-autostart.mjs'], cwd=repo, env=env, creationflags=flags)
output = repo / 'artifacts/product-gaps-20261004/autostart'
violations = []; checked = 0
for root in [output, Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/ai-channels', Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/codex-runtime']:
    if not root.exists(): continue
    for directory, directories, files in os.walk(root):
        directories[:] = [name for name in directories if name not in ['node_modules', '.git', 'skills', 'vendor']]
        for name in files:
            file = Path(directory) / name
            if not file.is_file() or file.stat().st_size > 64 * 1024 * 1024 or (root != output and file.stat().st_mtime < started_at): continue
            try: data = file.read_bytes()
            except PermissionError: continue
            checked += 1
            if key.encode() in data: violations.append(str(file))
audit = {'passed': not violations, 'filesChecked': checked, 'plaintextCredentialFiles': violations}
output.mkdir(parents=True, exist_ok=True)
(output / 'credential-audit.json').write_text(json.dumps(audit, indent=2), encoding='utf-8')
print(json.dumps({'exitCode': completed.returncode, 'credentialAudit': audit}))
sys.exit(1 if violations else completed.returncode)
