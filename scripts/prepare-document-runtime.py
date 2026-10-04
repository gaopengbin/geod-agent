"""Prepare pinned PDF/Office encryption dependencies beside the local interpreter."""
from pathlib import Path
import hashlib, json, os, shutil, urllib.request, zipfile
from importlib.util import module_from_spec, spec_from_file_location

repo = Path(__file__).resolve().parents[1]
resource_parent = (repo / 'apps/geod-agent-desktop/src-tauri/resources').resolve()
destination = resource_parent / 'documents'
lock = repo / 'vendor/document-runtime.lock.json'
patch_source = repo / 'scripts/patch-document-crypto.py'
package = json.loads(lock.read_text(encoding='utf-8'))
packages = [package, *package.get('dependencies', [])]
def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()
manifest = destination / 'manifest.json'
if manifest.is_file():
    value = json.loads(manifest.read_text(encoding='utf-8'))
    if value.get('lockSha256') == digest(lock) and value.get('patchSha256') == digest(patch_source) and all((destination / name).is_file() and digest(destination / name) == sha for name, sha in value['files'].items()):
        print('Verified bundled document parser: ' + package['name'] + ' ' + package['version']); raise SystemExit(0)
cache = Path(os.environ['LOCALAPPDATA']) / 'GeoD Agent/runtime-cache'
cache.mkdir(parents=True, exist_ok=True)
archives=[]
for item in packages:
    wheel = cache / item['wheel']
    if not wheel.is_file() or digest(wheel) != item['sha256']:
        with urllib.request.urlopen(item['url'], timeout=60) as response: wheel.write_bytes(response.read())
    if digest(wheel) != item['sha256']: raise SystemExit('Pinned document parser checksum mismatch: '+item['name'])
    archives.append(wheel)
if destination.exists():
    if destination.resolve().parent != resource_parent: raise SystemExit('Unexpected generated resource target')
    shutil.rmtree(destination)
destination.mkdir(parents=True)
for wheel in archives:
    with zipfile.ZipFile(wheel) as bundle:
        if any(not (destination / item.filename).resolve().is_relative_to(destination.resolve()) for item in bundle.infolist()):
            raise SystemExit('Invalid parser archive member')
        bundle.extractall(destination)
spec=spec_from_file_location('document_crypto_patch',patch_source)
patch=module_from_spec(spec);spec.loader.exec_module(patch)
patched=patch.patch_document_crypto(destination)
manifest.write_text(json.dumps({'name': package['name'], 'version': package['version'], 'license': package['license'], 'packages':[{key:item[key] for key in ['name','version','license','sha256']} for item in packages], 'lockSha256': digest(lock), 'patchSha256':digest(patch_source), 'patches':patched, 'files': {file.relative_to(destination).as_posix(): digest(file) for file in sorted(destination.rglob('*')) if file.is_file()}}, indent=2), encoding='utf-8')
print('Prepared bundled document parser: ' + package['name'] + ' ' + package['version'])
