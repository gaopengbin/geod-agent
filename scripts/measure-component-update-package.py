"""Create a locally signed application-only candidate and measure real payloads.

Uses an ephemeral QA key and example.test URLs; cannot activate a public channel.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from component_updates import bundle_application, package_components
from build_release_candidate_for_tests import load_builder
from update_signing_vault import public_environment
from release_build_identity import release_environment

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts/component-updates-20261012/package'
CANDIDATE = ROOT / 'artifacts/release-candidate-component-updates-20261012'
if OUTPUT.exists():
    raise SystemExit('Preserve existing package evidence; use a fresh output directory')
OUTPUT.mkdir(parents=True)
candidate = json.loads((CANDIDATE / 'candidate.json').read_text(encoding='utf-8'))
version = candidate['version']
full = CANDIDATE / f'GeoD Agent_{version}_x64-setup.exe'
exe = ROOT / 'apps/geod-agent-desktop/src-tauri/target/release/geod-agent-desktop.exe'
def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
if sha(exe) != candidate['mainExecutableSha256'] or sha(full) != candidate['artifacts'][full.name]['sha256']:
    raise SystemExit('Candidate and compiled application differ')
builder = load_builder()
env, _ = builder.trust_environment(release_environment(os.environ), False)
application = bundle_application(ROOT, OUTPUT, env, builder.bundle_config(env, False, 'lzma'))
cli = ROOT / 'apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js'
node = shutil.which('node')
with tempfile.TemporaryDirectory(prefix='geod-component-package-signing-') as temporary:
    key = Path(temporary) / 'ephemeral-qa-key'
    def signer(args):
        result = subprocess.run([node, str(cli), 'signer', *args], stdin=subprocess.DEVNULL, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError('QA signing failed; no private output displayed')
    signer(['generate', '--ci', '--write-keys', str(key)])
    def sign(file, release_version):
        signer(['sign', '--private-key-path', str(key), '--app-version', release_version, str(file)])
    sign(full, version) if not Path(str(full) + '.sig').exists() else None
    # The full installer remains in its original candidate; QA latest metadata
    # references it by name without copying hundreds of megabytes again.
    public_env = public_environment(dict(env, GEOD_UPDATE_PUBLIC_KEY=key.with_suffix('.pub').read_text(encoding='utf-8').strip()))
    subprocess.run([node, str(ROOT / 'scripts/update-candidate.mjs'), str(full), version, 'https://updates.example.test/qa', str(OUTPUT)], env=public_env, check=True)
    receipt = package_components(ROOT, OUTPUT, application, version, 'https://updates.example.test/qa', sign)
    sevenzip = shutil.which('7z') or r'C:\Program Files\7-Zip\7z.exe'
    listing = subprocess.check_output([sevenzip, 'l', '-slt', str(application)], creationflags=subprocess.CREATE_NO_WINDOW).decode('utf-8', errors='replace')
    for name in ['codex-runtime', 'pgedge-runtime', 'document-runtime', 'dbhub-runtime', 'audio-runtime', 'python-runtime']:
        assert name not in listing, name + ' unexpectedly retained in small installer'
    with tempfile.TemporaryDirectory(prefix='geod-small-installer-') as extracted:
        subprocess.run([sevenzip, 'x', '-y', '-bso0', '-bsp0', '-o' + extracted, str(application)], check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        files = list(Path(extracted).rglob('geod-agent-desktop.exe'))
        assert len(files) == 1 and sha(files[0]) == candidate['mainExecutableSha256']
    receipt.update(fullInstallerBytes=full.stat().st_size, applicationBytes=application.stat().st_size,
                   reductionPercent=round((1 - application.stat().st_size / full.stat().st_size) * 100, 2),
                   actualNsisPayloadVerified=True, applicationExecutableMatchesFullInstaller=True,
                   originalInstallerPreserved=sha(full) == candidate['artifacts'][full.name]['sha256'],
                   testKeyOnly=True, publicChannelActivated=False, installed=False, published=False)
    (OUTPUT / 'package-acceptance.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt))
