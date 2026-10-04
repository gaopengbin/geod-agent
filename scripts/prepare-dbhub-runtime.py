"""Prepare the pinned local SQL MCP runtime. Never installs into a user's Node environment."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
from importlib.util import spec_from_file_location, module_from_spec

repo = Path(__file__).resolve().parents[1]
source = repo / 'vendor' / 'dbhub'
target = repo / 'apps' / 'geod-agent-desktop' / 'src-tauri' / 'resources' / 'dbhub'
assert target.resolve().is_relative_to((repo / 'apps' / 'geod-agent-desktop' / 'src-tauri' / 'resources').resolve())
config = target.parent.parent / 'dbhub-config.toml'
inputs = {'package.json': source / 'package.json', 'package-lock.json': source / 'package-lock.json', 'dbhub.toml': config}
extension = target / 'node_modules/@bytebase/dbhub/dist/geod-tls.mjs'
if (target / 'manifest.json').is_file():
    manifest = json.loads((target / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('geodTlsExtension') == 2 and extension.is_file() and extension.read_bytes() == (source / 'geod-tls.mjs').read_bytes() and all((target / name).is_file() and (target / name).read_bytes() == value.read_bytes() for name, value in inputs.items()) and all((target / name).is_file() and hashlib.sha256((target / name).read_bytes()).hexdigest() == sha for name, sha in manifest.get('files', {}).items()) and manifest.get('files'):
        print(json.dumps({'verified': True, 'dbhubVersion': manifest['dbhubVersion'], 'files': len(manifest['files'])}))
        raise SystemExit(0)

target.mkdir(parents=True, exist_ok=True)
for name in ('package.json', 'package-lock.json'):
    shutil.copyfile(source / name, target / name)
shutil.copyfile(target.parent.parent / 'dbhub-config.toml', target / 'dbhub.toml')
command = ['npm.cmd' if os.name == 'nt' else 'npm', 'ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']
subprocess.run(command, cwd=target, check=True)
spec = spec_from_file_location('geod_dbhub_tls_patch', Path(__file__).with_name('patch-dbhub-tls.py'))
module = module_from_spec(spec)
spec.loader.exec_module(module)
module.patch(target, source)
files = {}
for path in sorted(target.rglob('*')):
    if path.is_symlink():
        raise RuntimeError('Runtime must not contain symlinks')
    if path.is_file() and path.name != 'manifest.json':
        files[path.relative_to(target).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
manifest = {'dbhubVersion': '1.4.0', 'source': 'https://github.com/bytebase/dbhub', 'nodeVersion': 'v24.21.0', 'geodTlsExtension': 2, 'files': files}
(target / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'prepared': True, 'dbhubVersion': manifest['dbhubVersion'], 'files': len(files), 'bytes': sum((target / name).stat().st_size for name in files)}))
