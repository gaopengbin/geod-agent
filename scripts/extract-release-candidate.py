"""Inspect a verified NSIS payload in a fresh artifact directory without installing it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
output = Path(parser.parse_args().output).resolve()
if not output.is_relative_to(ROOT / 'artifacts') or not output.name.startswith('release-candidate-'):
    raise SystemExit('Candidate must stay under the release candidate artifacts directory')
candidate = json.loads((output / 'candidate.json').read_text(encoding='utf-8'))
installer = output / f"GeoD Agent_{candidate['version']}_x64-setup.exe"
with installer.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != candidate['artifacts'][installer.name]['sha256']:
    raise SystemExit('Installer bytes differ from the verified candidate')
payload = output / 'installer-payload'
if payload.exists():
    raise SystemExit('Preserve the existing payload; choose a fresh candidate output')
sevenzip = shutil.which('7z') or r'C:\Program Files\7-Zip\7z.exe'
payload.mkdir()
subprocess.run([sevenzip, 'x', '-bso0', '-bsp0', f'-o{payload}', str(installer)],
               check=True, creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({'extracted': True, 'installed': False,
                  'executablePresent': (payload / 'geod-agent-desktop.exe').is_file()}))
