"""Build reviewable Windows artifacts only. Does not install or publish anything."""
from pathlib import Path
from urllib.parse import urlsplit
import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from release_inventory import inventory
from release_build_identity import release_environment, source_config, write_stamp

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'apps/geod-agent-desktop'

def trust_environment(env, signed):
    output = dict(env)
    if not signed:
        for key in ('GEOD_UPDATE_ENDPOINT', 'GEOD_UPDATE_PUBLIC_KEY', 'GEOD_UPDATE_ARTIFACT_BASE', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'):
            output.pop(key, None)
        return output, {'configured': False}
    for key in ('GEOD_UPDATE_ENDPOINT', 'GEOD_UPDATE_PUBLIC_KEY', 'GEOD_UPDATE_ARTIFACT_BASE', 'TAURI_SIGNING_PRIVATE_KEY'):
        if not output.get(key):
            raise ValueError('Signed candidate configuration is missing: ' + key)
    for key in ('GEOD_UPDATE_ENDPOINT', 'GEOD_UPDATE_ARTIFACT_BASE'):
        url = urlsplit(output[key])
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Release update addresses require HTTPS without credentials.')
    public = base64.b64decode(output['GEOD_UPDATE_PUBLIC_KEY'], validate=True).decode('utf-8').strip().splitlines()
    if len(public) != 2 or not public[0].startswith('untrusted comment:'):
        raise ValueError('The Tauri build public key is invalid.')
    packet = base64.b64decode(public[1], validate=True)
    if len(packet) != 42 or packet[:2] not in (b'Ed', b'ED'):
        raise ValueError('The update public key packet is invalid.')
    return output, {'configured': True, 'endpoint': output['GEOD_UPDATE_ENDPOINT'], 'publicKeyFingerprint': hashlib.sha256(packet).hexdigest()}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--signed-update', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--installer-compression', choices=['lzma','zlib'], default='lzma')
    args = parser.parse_args()
    target = Path(args.output).resolve()
    if not target.is_relative_to(ROOT / 'artifacts') or not target.name.startswith('release-candidate-'):
        raise ValueError('Use a fresh release-candidate directory under artifacts.')
    source_config(DESKTOP / 'src-tauri')
    environment, trust = trust_environment(release_environment(os.environ), args.signed_update)
    if args.dry_run:
        record = inventory(ROOT)
        record.update(updateChannel=trust, installed=False, published=False, dryRun=True)
        target.mkdir(parents=True, exist_ok=True)
        (target / 'preflight.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
        print(json.dumps({'preflight': True, 'runtimes': len(record['runtimes']), 'signedUpdate': trust['configured'], 'installed': False, 'published': False}))
        return
    if target.exists():
        raise ValueError('Preserve existing candidate outputs and use a fresh directory.')
    node = shutil.which('node')
    if not node:
        raise ValueError('Node is required in the build environment.')
    cli = DESKTOP / 'node_modules/@tauri-apps/cli/tauri.js'
    with tempfile.TemporaryDirectory(prefix='geod-release-build-') as temporary:
        config = Path(temporary) / 'build.json'
        config.write_text(json.dumps({'bundle': {'createUpdaterArtifacts': args.signed_update, 'windows': {'nsis': {'compression': args.installer_compression}}}}), encoding='utf-8')
        subprocess.run([node, str(cli), 'build', '--ci', '--bundles', 'nsis', '--config', str(config)], cwd=DESKTOP, env=environment, check=True)
    identity = write_stamp(DESKTOP / 'src-tauri', DESKTOP / 'src-tauri/target/release')
    record = inventory(ROOT)
    subprocess.run([shutil.which('python') or 'python', '-X', 'utf8', str(ROOT / 'scripts/package-release-candidate.py'), str(target)], cwd=ROOT, env=environment, check=True)
    record.update(updateChannel=trust, installerCompression=args.installer_compression, buildIdentity=identity, installed=False, published=False)
    (target / 'build-receipt.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    if args.signed_update:
        installer = DESKTOP / 'src-tauri/target/release/bundle/nsis' / f"GeoD Agent_{record['version']}_x64-setup.exe"
        shutil.copyfile(str(installer) + '.sig', target / (installer.name + '.sig'))
        subprocess.run([node, str(ROOT / 'scripts/update-candidate.mjs'), str(installer), record['version'], environment['GEOD_UPDATE_ARTIFACT_BASE'], str(target)], cwd=ROOT, env=environment, check=True)
    print(json.dumps({'candidate': str(target), 'signedUpdate': trust['configured'], 'installed': False, 'published': False}))

if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
