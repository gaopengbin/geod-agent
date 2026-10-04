"""Prepare the pinned CPU speech engine; model weights are optional local downloads."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'vendor/audio/runtime-lock.json'
parser = argparse.ArgumentParser()
parser.add_argument('--model', choices=['base', 'tiny'])
args = parser.parse_args()
spec = json.loads(LOCK.read_text(encoding='utf-8'))
cache = ROOT / 'artifacts/runtime-cache/audio'
runtime = ROOT / 'apps/geod-agent-desktop/src-tauri/resources/audio'
cache.mkdir(parents=True, exist_ok=True)
runtime.mkdir(parents=True, exist_ok=True)

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def download(url, destination, size, sha):
    if destination.exists() and destination.stat().st_size == size and digest(destination) == sha:
        return
    pending = destination.with_suffix(destination.suffix + '.pending')
    print('Downloading pinned ' + destination.name, flush=True)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'GeoD-Agent-build'}), timeout=60) as response, pending.open('wb') as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > size:
                    raise ValueError('Downloaded asset exceeds pinned size')
                output.write(chunk)
        if pending.stat().st_size != size or digest(pending) != sha:
            raise ValueError('Pinned audio asset checksum mismatch')
        pending.replace(destination)
    finally:
        pending.unlink(missing_ok=True)

archive = cache / 'whisper-bin-x64-b5130.zip'
download(spec['archive']['url'], archive, spec['archive']['bytes'], spec['archive']['sha256'])
for filename in ['SDL2.dll', 'llama.dll', 'parakeet.dll']:
    # These belonged to unrelated examples in the upstream archive. Do not ship
    # them as dependencies of whisper-cli; preserve all other unexpected files.
    (runtime / filename).unlink(missing_ok=True)
with zipfile.ZipFile(archive) as compressed:
    entries = [item for item in compressed.infolist() if not item.is_dir()]
    expected_files = {'LICENSE-whisper.txt', 'runtime-lock.json', 'manifest.json'}
    for item in entries:
        relative = Path(item.filename)
        if relative.is_absolute() or '..' in relative.parts or item.file_size > 64 * 1024 * 1024:
            raise ValueError('Invalid audio archive entry')
        if relative.name in ['whisper-cli.exe', 'whisper.dll'] or relative.name.startswith('ggml') and relative.suffix.lower() == '.dll':
            if relative.name in expected_files:
                raise ValueError('Duplicate audio archive filename')
            expected_files.add(relative.name)
            with compressed.open(item) as source, (runtime / relative.name).open('wb') as target:
                shutil.copyfileobj(source, target)
    unexpected = [file.name for file in runtime.iterdir() if file.is_file() and file.name not in expected_files]
    if unexpected:
        raise ValueError('Preserve and review unexpected audio runtime files: ' + ', '.join(unexpected))
    print(json.dumps({'archiveFiles': len(entries), 'engineFiles': sorted(file.name for file in runtime.iterdir())}), flush=True)
if not (runtime / 'whisper-cli.exe').is_file():
    raise ValueError('Upstream archive is missing the speech engine')
license_url = f"https://raw.githubusercontent.com/ggml-org/whisper.cpp/{spec['binaryTag']}/LICENSE"
with urllib.request.urlopen(license_url, timeout=60) as response:
    license_text = response.read(64 * 1024)
if b'MIT License' not in license_text:
    raise ValueError('Upstream engine license cannot be verified')
(runtime / 'LICENSE-whisper.txt').write_bytes(license_text)
shutil.copy2(LOCK, runtime / 'runtime-lock.json')
files = {file.name: {'bytes': file.stat().st_size, 'sha256': digest(file)} for file in runtime.iterdir() if file.is_file() and file.name != 'manifest.json'}
(runtime / 'manifest.json').write_text(json.dumps({'engine': spec['engine'], 'version': spec['version'], 'binaryTag': spec['binaryTag'], 'files': files}, indent=2), encoding='utf-8')
if args.model:
    model = next(item for item in spec['models'] if item['id'] == args.model)
    download(f"https://huggingface.co/ggerganov/whisper.cpp/resolve/{spec['modelRevision']}/{model['filename']}",
             cache / model['filename'], model['bytes'], model['sha256'])
print(json.dumps({'verified': True, 'engine': spec['engine'], 'version': spec['version'], 'files': len(files), 'model': args.model}))
