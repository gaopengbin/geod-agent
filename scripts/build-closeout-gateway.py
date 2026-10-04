"""Build a frozen Linux gateway bundle locally; never contact or change production."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--package-only', action='store_true', help='Resume packaging only after the retained Linux dependency and test gates passed.')
args = parser.parse_args()
output = Path(args.output).resolve()
assert output.is_relative_to(ROOT / 'artifacts') and output.name.startswith('gateway-release-')
if not args.package_only:
    assert not output.exists(), 'Keep previous build evidence'
    output.mkdir()
else:
    assert output.exists() and not (output/'candidate.json').exists()
    assert 'added 99 packages' in (output/'linux-dependencies.log').read_text(encoding='utf-8')
    log = (output/'linux-tests.log').read_text(encoding='utf-8')
    assert 'pass 62' in log and 'fail 0' in log and 'skipped 0' in log
stage = output / 'staging'
service = stage / 'services/geod-agent-model-gateway'
protocol = stage / 'packages/codex-protocol'
service.mkdir(parents=True, exist_ok=args.package_only)
protocol.mkdir(parents=True, exist_ok=args.package_only)

def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

source = {}
for directory in [ROOT/'services/geod-agent-model-gateway', ROOT/'packages/codex-protocol']:
    for file in sorted(directory.glob('*.mjs')):
        if file.name.endswith('.test.mjs'):
            continue
        destination = stage / file.relative_to(ROOT)
        if not args.package_only:
            shutil.copy2(file, destination)
        else:
            assert sha(file) == sha(destination)
        source[file.relative_to(ROOT).as_posix()] = sha(file)
for name in ['package.json', 'package-lock.json']:
    file = ROOT/'services/geod-agent-model-gateway'/name
    if not args.package_only:
        shutil.copy2(file, service/name)
    else:
        assert sha(file) == sha(service/name)
    source[file.relative_to(ROOT).as_posix()] = sha(file)
if not args.package_only:
    shutil.copytree(ROOT/'services/geod-agent-model-gateway/test', service/'test',
                   ignore=shutil.ignore_patterns('live-smoke.mjs', 'native-live-smoke.mjs', '*live*', 'node_modules'))
image = json.loads(subprocess.check_output(['docker','image','inspect','node:22.23.2-bookworm'],text=True))[0]
image_id = image['Id']
assert image['Architecture'] == 'amd64' and image['Os'] == 'linux'
mount = f'type=bind,source={stage},target=/candidate'
common = ['docker','run','--rm','--init','--mount',mount,'--workdir','/candidate/services/geod-agent-model-gateway']
creation = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
def run(name,command):
    with (output/name).open('w',encoding='utf-8') as log:
        result = subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,creationflags=creation)
    if result.returncode:
        raise SystemExit(f'{name} failed; see retained log')

# All downloads happen in the local Docker engine. The server receives a
# complete hash-checked archive and does not install or fetch dependencies.
if not args.package_only:
    run('linux-dependencies.log',common + [image_id,
        'npm','ci','--omit=dev','--no-audit','--no-fund','--logs-dir=/candidate/npm-build-logs'])
tests = sorted(p.name for p in (service/'test').glob('*.test.mjs'))
if not args.package_only:
    run('linux-tests.log',common + ['--network','none',image_id,'node','--test',
        '--test-reporter=spec',*[f'test/{name}' for name in tests]])
assert all(sha(ROOT/name) == digest for name,digest in source.items()), 'Source changed during Linux build'
assert all(sha(stage/name) == digest for name,digest in source.items())
assert not (service/'payment-history-candidate.mjs').exists()
archive = output/'geod-agent-gateway-0.2.0-linux-x64.tar.gz'
run('linux-package.log',common + ['--network','none','--mount',
    f'type=bind,source={ROOT / "scripts/package-closeout-gateway-linux.py"},target=/package.py,readonly',
    image_id,'python3','/package.py'])
shutil.move(stage/'gateway-linux-x64.tar.gz',archive)
inventory = json.loads((stage/'linux-files.json').read_text(encoding='utf-8'))
files = inventory['files']
assert any(name.endswith('better_sqlite3.node') for name in files)
receipt = dict(version='0.2.0',platform='linux-x64',node='22.23.2',imageId=image_id,
    imageDigests=image['RepoDigests'],sourceFiles=source,archive=archive.name,
    archiveSha256=sha(archive),archiveBytes=archive.stat().st_size,files=files,symlinks=inventory['symlinks'],
    tests=tests,published=False,uploaded=False,productionModified=False,
    paymentEnabled=False,configurationIncluded=False,databaseIncluded=False)
(output/'candidate.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
print(json.dumps({key:value for key,value in receipt.items() if key not in {'files','sourceFiles'}}),flush=True)
