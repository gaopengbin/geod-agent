"""Create a private QA-only Oracle auto-login wallet with Oracle's pinned jars."""
from pathlib import Path
import json
import subprocess
import shutil
import argparse

repo = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args()
output=(args.output or repo/'artifacts/product-gaps-20261004/database-tls').resolve()
assert output.is_relative_to(repo/'artifacts/product-gaps-20261004') and not output.is_symlink()
root = output/'private/oracle'
state = json.loads((root / 'state.json').read_text())
wallet = root / 'wallet'
wallet.mkdir(exist_ok=True)
java = repo / 'apps/geod-agent-desktop/src-tauri/resources/legacy-office/java/bin/java.exe'
classpath = ';'.join(str(root / 'tools' / (name + '.jar')) for name in ('oraclepki', 'osdt_core', 'osdt_cert'))

def run(*args):
    result = subprocess.run([str(java), '-Duser.language=en', '-Duser.country=US', '-cp', classpath,
                             'oracle.security.pki.textui.OraclePKITextUI', 'wallet', *args], capture_output=True)
    text = (result.stdout + result.stderr).decode('utf-8', errors='replace')
    assert state['walletPassword'] not in text
    if result.returncode:
        raise RuntimeError(text[:1600])
    return text

if not (wallet / 'cwallet.sso').exists():
    run('create', '-wallet', str(wallet), '-pwd', state['walletPassword'], '-auto_login')
    run('import_pkcs12', '-wallet', str(wallet), '-pwd', state['walletPassword'],
        '-pkcs12file', str(root / 'server.p12'), '-pkcs12pwd', state['walletPassword'])
    run('create', '-wallet', str(wallet), '-pwd', state['walletPassword'], '-auto_login')
display = run('display', '-wallet', str(wallet), '-pwd', state['walletPassword'], '-summary')
assert 'localhost' in display
assert (wallet / 'cwallet.sso').is_file()
print(json.dumps({'walletReady': True, 'qaOnly': True, 'certificateHost': 'localhost'}))
