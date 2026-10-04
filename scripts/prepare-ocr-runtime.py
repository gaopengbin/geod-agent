"""Prepare pinned OCR packages using the existing isolated application interpreter."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import urllib.request

repo = Path(__file__).resolve().parents[1]
resource_parent = (repo / 'apps/geod-agent-desktop/src-tauri/resources').resolve()
destination = resource_parent / 'ocr'
lock = repo / 'vendor/ocr-runtime.lock'
source_lock = repo / 'vendor/ocr-sources.lock.json'
python = resource_parent / 'gdal/python.exe'

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

assert python.is_file() and lock.is_file() and source_lock.is_file(), 'Prepare the GIS interpreter and pinned OCR locks first'
manifest_file = destination / 'manifest.json'
if manifest_file.is_file():
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    if manifest.get('lockSha256') == digest(lock) and manifest.get('sourcesLockSha256') == digest(source_lock) and all(
        (destination / name).is_file() and digest(destination / name) == expected
        for name, expected in manifest['files'].items()
    ):
        print(f"Verified bundled CPU OCR: {len(manifest['files'])} files")
        raise SystemExit(0)
if destination.exists():
    assert destination.resolve().parent == resource_parent, 'Unexpected generated resource target'
    shutil.rmtree(destination)
destination.mkdir(parents=True)
# OmegaConf's ANTLR dependency is pure Python and publishes only a source archive.
# The source archive is hash pinned; all other packages must have Windows wheels.
subprocess.run(['uv', 'pip', 'install', '--python', str(python), '--target', str(destination),
                '--require-hashes', '--no-deps', '--only-binary', ':all:',
                '--no-binary', 'antlr4-python3-runtime', '-r', str(lock), '--quiet'],
               check=True)
models = ['PP-OCRv6_det_small.onnx', 'PP-OCRv6_rec_small.onnx',
          'ch_ppocr_mobile_v2.0_cls_mobile.onnx']
assert all((destination / 'rapidocr/models' / model).is_file() for model in models)
cache = Path(os.environ['LOCALAPPDATA']) / 'GeoD Agent/runtime-cache'
cache.mkdir(parents=True, exist_ok=True)
for item in json.loads(source_lock.read_text(encoding='utf-8'))['licenses']:
    filename = item['filename']; assert Path(filename).name == filename
    file = cache / filename
    if not file.is_file() or digest(file) != item['sha256']:
        with urllib.request.urlopen(item['url'], timeout=60) as response:
            file.write_bytes(response.read())
    assert digest(file) == item['sha256'], 'Pinned OCR license checksum mismatch'
    shutil.copyfile(file, destination / filename)
environment = {key: value for key, value in os.environ.items()
               if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'}}
environment['PATH'] = str(Path(os.environ['SYSTEMROOT']) / 'System32')
check = "import sys;sys.dont_write_bytecode=True;sys.path.insert(0,sys.argv[1]);import rapidocr,onnxruntime,pypdfium2;assert 'CPUExecutionProvider' in onnxruntime.get_available_providers();print('Actual isolated imports: CPU ONNX Runtime, RapidOCR and PDFium')"
subprocess.run([str(python), '-I', '-X', 'utf8', '-c', check, str(destination)],
               env=environment, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
manifest = {'name': 'geod-cpu-ocr', 'version': '3.9.2', 'pythonVersion': '3.13',
            'engine': 'RapidOCR PP-OCRv6 small / ONNX Runtime CPU',
            'pdfRenderer': 'pypdfium2 5.13.0 / PDFium', 'lockSha256': digest(lock),
            'sourcesLockSha256': digest(source_lock),
            'files': {file.relative_to(destination).as_posix(): digest(file)
                      for file in sorted(destination.rglob('*'))
                      if file.is_file() and '__pycache__' not in file.parts}}
manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'prepared': True, 'files': len(manifest['files']),
                  'bytes': sum(file.stat().st_size for file in destination.rglob('*') if file.is_file())}))
