"""Remove this acceptance's isolated fixtures and inspect mutable records for secrets."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import psutil
import shutil
import subprocess
from cryptography.hazmat.primitives import serialization

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['processes', 'files'])
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
root = (repo/'artifacts/product-gaps-20261004/database-keys').resolve(strict=True)
assert root.is_relative_to(repo.resolve()) and root.name == 'database-keys' and not root.is_symlink()
saved = json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
assert saved.get('cleaned'), 'Restore the original sidebar and connection list first'
providers = ('postgis', 'mysql', 'mariadb', 'oracle')
private = (root/'private').resolve(strict=True)
assert private.parent == root and private.name == 'private' and not private.is_symlink()
states = {p: json.loads((private/p/'state.json').read_text(encoding='utf-8')) for p in providers}
passwords = set()
keys = set()
for folder in private.iterdir():
    assert folder.name in (*providers, 'parser') and folder.is_dir() and not folder.is_symlink()
    for directory, folders, files in os.walk(folder, followlinks=False):
        for name in [*folders, *files]:
            item = Path(directory)/name
            assert not item.is_symlink() and item.resolve().is_relative_to(private)
    keys.update(file.read_text(encoding='utf-8') for file in folder.glob('*.key'))
for state in states.values():
    passwords.update(state[k] for k in ('password', 'readerPassword', 'keyPassword') if state.get(k))
for provider in providers:
    key = serialization.load_pem_private_key((private/provider/'client.key').read_bytes(), None)
    keys.add(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode())
for fixture in json.loads((private/'parser/inputs.json').read_text(encoding='utf-8')).values():
    if fixture.get('password'):
        passwords.add(fixture['password'])
    for key in ('key', 'encrypted', 'plain'):
        if fixture.get(key):
            keys.add(fixture[key])
    if fixture.get('key') and fixture.get('password'):
        key = serialization.load_pem_private_key(fixture['key'].encode(), fixture['password'].encode())
        keys.add(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode())

needles = set()
for value in [*passwords, *keys]:
    for text in [value, json.dumps(value, ensure_ascii=False)[1:-1], json.dumps(value, ensure_ascii=True)[1:-1]]:
        needles.update((text.encode('utf-8'), text.encode('utf-16-le')))
# A conventional PEM key line remains detectable after JSON newline escaping.
for key in keys:
    lines = [line.strip() for line in key.splitlines() if len(line.strip()) >= 48 and not line.startswith('-')]
    needles.update(line.encode('ascii') for line in lines[:2] if line.isascii())
assert passwords and keys and all(needles)

app = Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'
expected = (repo/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve()
def native():
    return [p for p in psutil.process_iter(['name']) if p.info['name'] == 'geod-agent-desktop.exe' and Path(p.exe()).resolve() == expected]

if args.mode == 'processes':
    processes = native()
    assert len(processes) == 2
    descendants = {p.pid: p for p in processes}
    for process in processes:
        descendants.update({p.pid: p for p in process.children(recursive=True)})
    checked = []
    for process in descendants.values():
        text = json.dumps(dict(argv=process.cmdline(), env=process.environ()), ensure_ascii=False)
        assert not any(value in text or json.dumps(value, ensure_ascii=False)[1:-1] in text for value in [*passwords, *keys]), 'Fixture secret entered native process arguments or environment'
        checked.append(dict(pid=process.pid, createdAt=process.create_time(), name=process.name()))
    report = dict(passed=True, processesChecked=checked, scope='Development desktop, companion and their actual descendants')
    (root/'process-secret-audit.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(dict(passed=True, processesChecked=len(checked))), flush=True)
    raise SystemExit(0)

assert not native(), 'Close both development instances normally before checking WebView and TLS session files'
assert json.loads((root/'process-secret-audit.json').read_text())['passed']
owned = Path(saved['credentialFolder']).resolve(strict=True)
workspace = Path(saved['workspace']).resolve(strict=True)
assert owned.parent == workspace and owned.name == saved['credentialPrefix'] and owned.name.startswith('.geod-key-qa-') and not owned.is_symlink()
allowed = {p+'-encrypted.json' for p in providers} | {'postgis-missing-key-password.json'}
assert {p.name for p in owned.iterdir()} == allowed
for file in owned.iterdir():
    assert file.is_file() and not file.is_symlink() and file.resolve().parent == owned
    file.unlink()
owned.rmdir()

removed = []
for provider, state in states.items():
    name = state['container']
    assert name.startswith('geod-agent-keys-'+provider+'-') or name.startswith('geod-agent-tls-'+provider+'-')
    inspected = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True, encoding='utf-8', check=True)
    item = json.loads(inspected.stdout)[0]
    assert item['Config']['Labels'].get('dev.geod-agent.fixture') == 'database-tls'
    assert item['Config']['Labels'].get('dev.geod-agent.fixture-id') == state['fixtureId']
    assert item['Image'] == state['imageId']
    subprocess.run(['docker', 'rm', '--force', '--volumes', name], check=True, stdout=subprocess.DEVNULL)
    removed.append(dict(provider=provider, ownedContainerRemoved=True, exactIdentityVerified=True))
    print(json.dumps(removed[-1]), flush=True)
credential_root = (root/'workspace').resolve(strict=True)
assert credential_root.parent == root and not credential_root.is_symlink()
allowed_files = {p+'-encrypted.json' for p in providers} | {p+'-tls.json' for p in providers if p != 'postgis'}
assert {p.name for p in credential_root.iterdir()} == allowed_files
for file in credential_root.iterdir():
    assert not file.is_symlink() and file.is_file() and file.resolve().parent == credential_root
    file.unlink()
credential_root.rmdir()
# All four provider directories and the parser inputs are owned by this fixture.
assert private.resolve() == root/'private' and private.is_relative_to(root)
shutil.rmtree(private)

excluded = {'node_modules', '.git', 'models', 'tmp-models', 'cache', '.cache', '.tmp', 'tmp', 'skills', 'plugins'}
checked, unreadable, violations = 0, [], []
maximum = max(map(len, needles))
for start in [root, app]:
    for directory, folders, files in os.walk(start, followlinks=False):
        folders[:] = [name for name in folders if name not in excluded and not (Path(directory)/name).is_symlink()]
        for name in files:
            file = Path(directory)/name
            if file.is_symlink():
                continue
            try:
                with file.open('rb') as stream:
                    tail = b''
                    while part := stream.read(1024*1024):
                        data = tail+part
                        if any(needle in data for needle in needles):
                            violations.append(str(file))
                            break
                        tail = data[-maximum:]
                checked += 1
            except OSError:
                unreadable.append(str(file))
report = dict(passed=not unreadable and not violations, passwordsChecked=len(passwords), privateKeysChecked=len(keys), filesChecked=checked,
              scope=['This acceptance evidence', 'Mutable native ledgers and transcripts', 'Complete backups', 'WebView state', 'Temporary TLS session material'],
              excludedImmutableOrUnrelatedDirectories=sorted(excluded), unreadableFiles=unreadable, violations=violations,
              ownedContainers=removed, ownedWorkspaceCredentialFolderRemoved=True, fixtureCredentialsAndPrivateKeysRemoved=True)
(root/'credential-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(passed=report['passed'], filesChecked=checked, passwordsChecked=len(passwords), privateKeysChecked=len(keys), unreadableFiles=len(unreadable), violations=len(violations))), flush=True)
if not report['passed']:
    raise SystemExit(1)
