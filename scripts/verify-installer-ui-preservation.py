"""Review actual welcome/cancel observations and preserve the existing installation.

The UI is operated separately with Computer Use. This verifier only reads local
registry, file bytes and process identities; it never executes an installer.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import psutil
import winreg

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--observations', required=True, type=Path)
parser.add_argument('--candidate', required=True, type=Path)
args = parser.parse_args()
observations, candidate = args.observations.resolve(), args.candidate.resolve()
assert observations.is_relative_to(ROOT/'artifacts') and candidate.is_relative_to(ROOT/'artifacts')
before = json.loads((observations/'before.json').read_text(encoding='utf-8'))
ui = json.loads((observations/'ui-observations.json').read_text(encoding='utf-8'))
metadata = json.loads((candidate/'candidate.json').read_text(encoding='utf-8'))
assert Path(ui['candidate']).resolve() == candidate and ui['installed'] is False and ui['welcomePagesOnly']
installer = candidate/f"GeoD Agent_{metadata['version']}_x64-setup.exe"

def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

assert sha(installer) == metadata['artifacts'][installer.name]['sha256']
cases = {case['name']: case for case in ui['cases']}
expected = {'initial-language-dialog', 'chinese-welcome', 'chinese-cancel',
            'english-selection', 'english-welcome', 'english-cancel'}
assert set(cases) == expected and len(ui['cases']) == len(expected)
assert all(text in cases['chinese-welcome']['tree'] for text in ['欢迎', '下一步', '取消'])
assert all(text in cases['english-welcome']['tree'] for text in ['Welcome', 'Next', 'Cancel'])
assert 'Value: English' in cases['english-selection']['tree']
assert cases['chinese-cancel']['remainingWindows'] == cases['english-cancel']['remainingWindows'] == 0

registry = {}
for name in before['registryValueHashes']:
    assert name in {'Software/Microsoft/Windows/CurrentVersion/Uninstall/GeoD Agent',
                    'Software/geod-agent/GeoD Agent', 'Software/Microsoft/Windows/CurrentVersion/Run'}
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, name.replace('/', '\\')) as key:
            values = [winreg.EnumValue(key, i) for i in range(winreg.QueryInfoKey(key)[1])]
            if name.endswith('/Run'):
                values = [row for row in values if row[0] in ['GeoD Agent', 'GeoD Agent Development']]
            registry[name] = hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    except FileNotFoundError:
        registry[name] = None
assert registry == before['registryValueHashes']
installed = Path(os.environ['LOCALAPPDATA'])/'Programs/GeoD Agent'
files = {}
for name in before['existingInstallFiles']:
    assert name in {'geod-agent-desktop.exe', 'uninstall.exe'}
    path = installed/name
    files[name] = {'bytes': path.stat().st_size, 'sha256': sha(path)}
assert files == before['existingInstallFiles']
for pid, created in before['protectedProcesses'].items():
    assert abs(psutil.Process(int(pid)).create_time()-created) < 0.01
live = [p.pid for p in psutil.process_iter(['pid', 'exe'])
        if os.path.normcase(p.info['exe'] or '') == os.path.normcase(str(installer))]
assert not live
result = {'passed': True, 'reviewedAt': datetime.now(timezone.utc).isoformat(),
          'installerSha256': sha(installer), 'version': metadata['version'], 'cases': len(cases),
          'registryKeysUnchanged': len(registry), 'existingInstalledFilesUnchanged': len(files),
          'protectedProcessIdentitiesUnchanged': len(before['protectedProcesses']),
          'testInstallerProcessesRemoved': True, 'installed': False, 'welcomePagesOnly': True,
          'allInstallerPagesVerified': False, 'systemLanguageChanged': False,
          'observationsSha256': sha(observations/'ui-observations.json'),
          'verifierSha256': sha(Path(__file__))}
with (observations/'result.json').open('x', encoding='utf-8') as stream:
    json.dump(result, stream, ensure_ascii=False, indent=2)
print(json.dumps(result), flush=True)
