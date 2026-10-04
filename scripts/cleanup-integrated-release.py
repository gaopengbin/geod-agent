"""Clean only this fixture's credentials/container and audit its mutable state."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import psutil
import re
import shutil
import subprocess
from cryptography.hazmat.primitives import serialization

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('mode', choices=['processes','files'])
args = parser.parse_args()
output = Path(args.output).resolve()
assert output.is_relative_to(repo/'artifacts') and output.name.startswith('release-candidate-')
root = (repo/'artifacts/product-gaps-20261004/integrated-release').resolve(strict=True)
assert root.parent == repo/'artifacts/product-gaps-20261004' and not root.is_symlink()
saved = json.loads((output/'integrated-qa-state.json').read_text(encoding='utf-8'))
assert saved.get('cleaned'), 'Remove the owned saved connections and disable its schedule first'
private = (root/'private').resolve(strict=True)
assert private.parent == root and not private.is_symlink()
state = json.loads((private/'postgis/state.json').read_text(encoding='utf-8'))
passwords = set(json.loads((private/'document-passwords.json').read_text(encoding='utf-8')).values())
passwords.update(state[key] for key in ('password','readerPassword','keyPassword') if state.get(key))
keys = set(file.read_text(encoding='utf-8') for file in (private/'postgis').glob('*.key'))
key = serialization.load_pem_private_key((private/'postgis/client.key').read_bytes(),None)
keys.add(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode())
values = [*passwords,*keys]
needles = set()
for value in values:
    for text in [value,json.dumps(value,ensure_ascii=False)[1:-1],json.dumps(value,ensure_ascii=True)[1:-1]]:
        needles.update((text.encode('utf-8'),text.encode('utf-16-le')))
for key in keys:
    lines = [line.strip() for line in key.splitlines() if len(line.strip()) >= 48 and not line.startswith('-')]
    needles.update(line.encode('ascii') for line in lines[:2] if line.isascii())
assert passwords and keys and all(needles)
candidate = json.loads((output/'candidate.json').read_text(encoding='utf-8'))
executable = (output/f"GeoD-Agent-{candidate['version']}-windows-x64/geod-agent-desktop.exe").resolve()
instances = [p for p in psutil.process_iter(['name']) if p.info['name'] == 'geod-agent-desktop.exe' and Path(p.exe()).resolve() == executable]
if args.mode == 'processes':
    assert len(instances) == 2
    processes = {process.pid:process for process in instances}
    for process in instances:
        processes.update({child.pid:child for child in process.children(recursive=True)})
    checked = []
    for process in processes.values():
        text = json.dumps(dict(argv=process.cmdline(),env=process.environ()),ensure_ascii=False)
        assert not any(value in text or json.dumps(value,ensure_ascii=False)[1:-1] in text for value in values), 'Fixture secret entered process arguments or environment'
        checked.append(dict(pid=process.pid,createdAt=process.create_time(),name=process.name()))
    report = dict(passed=True,processesChecked=checked,scope='Actual portable desktop, companion and their children')
    (output/'integrated-process-secret-audit.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(dict(passed=True,processesChecked=len(checked))),flush=True)
    raise SystemExit(0)
assert not instances, 'Close actual candidate processes normally before auditing WebView and native session files'
assert json.loads((output/'integrated-process-secret-audit.json').read_text(encoding='utf-8'))['passed']
owned = Path(saved['credentialFolder']).resolve(strict=True)
workspace = Path(saved['workspace']).resolve(strict=True)
assert owned.parent == workspace and owned.name == saved['credentialPrefix'] and owned.name.startswith('.geod-release-qa-') and not owned.is_symlink()
expected = {entry['name']:entry['sha256'] for entry in saved['workspaceFiles']}
assert set(expected) == {'postgis-encrypted.json','release.sqlite'}
assert {file.name for file in owned.iterdir()} == set(expected)
for file in owned.iterdir():
    assert file.is_file() and not file.is_symlink() and file.resolve().parent == owned
    assert hashlib.sha256(file.read_bytes()).hexdigest() == expected[file.name], 'Preserve changed fixture files for inspection'
    file.unlink()
owned.rmdir()
container = state['container']
assert container.startswith('geod-agent-keys-postgis-')
item = json.loads(subprocess.run(['docker','inspect',container],capture_output=True,text=True,encoding='utf-8',check=True).stdout)[0]
assert item['Config']['Labels'].get('dev.geod-agent.fixture') == 'database-tls'
assert item['Config']['Labels'].get('dev.geod-agent.fixture-id') == state['fixtureId'] and item['Image'] == state['imageId']
subprocess.run(['docker','rm','--force','--volumes',container],check=True,stdout=subprocess.DEVNULL)
credential = root/'workspace/postgis-encrypted.json'
assert credential.resolve().parent == (root/'workspace').resolve() and not credential.is_symlink()
credential.unlink()
for directory,folders,files in os.walk(private,followlinks=False):
    for name in [*folders,*files]:
        file = Path(directory)/name
        assert not file.is_symlink() and file.resolve().is_relative_to(private)
assert {item.name for item in private.iterdir()} == {'postgis','document-passwords.json'}
shutil.rmtree(private)
excluded = {'node_modules','.git','models','tmp-models','cache','.cache','.tmp','tmp','skills','plugins'}
app = Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'
local = Path(os.environ['LOCALAPPDATA'])/'dev.geod-agent.desktop'
paths = []
for start in [root,app,local]:
    for directory,folders,files in os.walk(start,followlinks=False):
        folders[:] = [name for name in folders if name not in excluded and not (Path(directory)/name).is_symlink()]
        paths.extend(Path(directory)/name for name in files if not (Path(directory)/name).is_symlink())
# Candidate runtimes/installer bytes were immutable before fixture secrets existed;
# their hashes are covered by integrated-payload.json. Include QA evidence and logs.
paths.extend(file for file in output.iterdir() if file.is_file() and file.suffix in {'.json','.log','.md','.txt'})
pattern = re.compile(b'|'.join(re.escape(needle) for needle in needles))
maximum = max(map(len,needles));checked=0;unreadable=[];violations=[]
for file in paths:
    try:
        with file.open('rb') as stream:
            tail=b''
            while part:=stream.read(1024*1024):
                data=tail+part
                if pattern.search(data):
                    violations.append(str(file));break
                tail=data[-maximum:]
        checked+=1
    except OSError:
        unreadable.append(str(file))
report = dict(passed=not unreadable and not violations,passwordsChecked=len(passwords),privateKeysChecked=len(keys),filesChecked=checked,
              scope=['This acceptance evidence/logs','Actual isolated mutable native state and complete backups','Both WebView/native profiles'],
              excludedImmutableOrUnrelatedDirectories=sorted(excluded),unreadableFiles=unreadable,violations=violations,
              exactOwnedContainerRemoved=True,ownedWorkspaceFolderRemoved=True,privateFixtureCredentialsRemoved=True,
              originalProfilesStillPreserved=True)
(output/'integrated-credential-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(dict(passed=report['passed'],filesChecked=checked,passwordsChecked=len(passwords),privateKeysChecked=len(keys),unreadableFiles=len(unreadable),violations=len(violations))),flush=True)
if not report['passed']:
    raise SystemExit(1)
