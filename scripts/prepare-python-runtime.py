"""Prepare only the pinned embedded interpreter. GIS packages are separate."""
from pathlib import Path
import hashlib, json, os, shutil, urllib.request, zipfile

ROOT=Path(__file__).resolve().parents[1]
resources=ROOT/'apps/geod-agent-desktop/src-tauri/resources';target=resources/'python'
pin={'pythonVersion':'3.13.11','archive':'https://www.python.org/ftp/python/3.13.11/python-3.13.11-embed-amd64.zip',
     'archiveSha256':'1ec066fb61ba5e8c73e29e048cd07c26850f74585e3a116005135b31b8004890'}
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
manifest=target/'manifest.json'
if manifest.is_file():
    saved=json.loads(manifest.read_text(encoding='utf-8'))
    if all(saved.get(k)==v for k,v in pin.items()) and all((target/n).is_file() and digest(target/n)==h for n,h in saved['files'].items()):
        print('Verified small Python runtime');raise SystemExit(0)
cache=ROOT/'artifacts/runtime-cache';cache.mkdir(parents=True,exist_ok=True)
archive=cache/'python-3.13.11-embed-amd64.zip'
legacy=Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/runtime-cache'/archive.name
if not archive.is_file() or digest(archive)!=pin['archiveSha256']:
    if legacy.is_file() and digest(legacy)==pin['archiveSha256']:shutil.copyfile(legacy,archive)
    else:
        with urllib.request.urlopen(pin['archive'],timeout=90) as response:archive.write_bytes(response.read())
if digest(archive)!=pin['archiveSha256']:raise SystemExit('Pinned Python archive checksum mismatch')
target.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(archive) as bundle:
    for entry in bundle.infolist():
        if not (target/entry.filename).resolve().is_relative_to(target.resolve()):raise SystemExit('Invalid Python archive path')
    bundle.extractall(target)
(target/'python313._pth').write_text('python313.zip\n.\nimport site\n',encoding='ascii')
pin['files']={p.name:digest(p) for p in target.iterdir() if p.is_file() and p.name!='manifest.json'}
manifest.write_text(json.dumps({'name':'geod-python-base',**pin},indent=2)+'\n',encoding='utf-8')
print(json.dumps({'prepared':True,'bytes':sum((target/n).stat().st_size for n in pin['files']),'files':len(pin['files'])}))
