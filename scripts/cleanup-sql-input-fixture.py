"""Clean only this acceptance run's private files/container; retain public evidence."""
from pathlib import Path
import json
import os
import subprocess
root = (Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/sql-inputs').resolve()
private_path = root / 'mysql-private-state.json'
private = json.loads(private_path.read_text(encoding='utf-8'))
container = private['container']
assert container.startswith('geod-agent-mysql-input-')
info = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
assert info['Config']['Labels'].get('dev.geod-agent.fixture') == 'sql-input'
subprocess.run(['docker', 'rm', '-f', '-v', container], check=True, stdout=subprocess.DEVNULL)
for name in ['mysql-private-state.json', 'workspace/' + private['credentialFile']]:
    target = (root / name).resolve()
    assert target.is_relative_to(root) and target.is_file()
    target.unlink()
secret = private['password'].encode('utf-8')
checked, skipped, violations = 0, [], []
folders = [root, Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop']
for folder in folders:
    for file in folder.rglob('*'):
        if not file.is_file():
            continue
        try:
            with file.open('rb') as stream:
                tail = b''
                while part := stream.read(1024 * 1024):
                    current = tail + part
                    if secret in current:
                        violations.append(str(file))
                        break
                    tail = current[-len(secret):]
            checked += 1
        except (PermissionError, OSError):
            skipped.append(str(file))
result = {'passed': not violations, 'filesChecked': checked, 'unreadableFiles': skipped,
          'violations': violations, 'ownedContainerRemoved': True, 'privateFixtureFilesRemoved': True}
(root / 'credential-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False))
if violations:
    raise SystemExit(1)
