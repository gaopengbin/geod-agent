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
from update_signing_vault import public_environment
from sign_update_candidate_for_tests import sign_module

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / 'apps/geod-agent-desktop'

def trust_environment(env, signed):
    output = dict(env)
    if not signed:
        output = public_environment(output)
        for key in ('GEOD_UPDATE_ENDPOINT', 'GEOD_UPDATE_PUBLIC_KEY', 'GEOD_UPDATE_ARTIFACT_BASE'):
            output.pop(key, None)
        return output, {'configured': False}
    output = public_environment(output)
    for key in ('GEOD_UPDATE_ENDPOINT', 'GEOD_UPDATE_PUBLIC_KEY', 'GEOD_UPDATE_ARTIFACT_BASE'):
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

def bundle_config(environment, signed, compression):
    # Tauri build also starts frontend, Cargo and bundler descendants. Compile
    # with public values only, then sign the packaged installer separately.
    config = {'bundle': {'createUpdaterArtifacts': False, 'windows': {'nsis': {'compression': compression}}}}
    if signed:
        # The bundler reads static plugin configuration before the application
        # registers the updater at runtime. These values are public only.
        config['plugins'] = {'updater': {'pubkey': environment['GEOD_UPDATE_PUBLIC_KEY'],
                                        'endpoints': [environment['GEOD_UPDATE_ENDPOINT']],
                                        'requireSignedVersion': True,
                                        'dangerousInsecureTransportProtocol': False}}
    return config

def environment_signing_key(environment):
    # CI runners receive an explicitly configured secret rather than the local
    # Windows vault. It stays in the parent and is passed only to the signer.
    encoded = environment.get('TAURI_SIGNING_PRIVATE_KEY', '').strip()
    try:
        document = base64.b64decode(encoded, validate=True).decode('utf-8').strip().splitlines()
        if len(document) != 2 or not document[0].startswith('untrusted comment: rsign encrypted secret key'):
            raise ValueError()
        base64.b64decode(document[1], validate=True)
    except (ValueError, UnicodeError):
        raise ValueError('CI signing requires an inline encoded Tauri key; no signing value was displayed.') from None
    return {'privateKey': encoded, 'privateKeyPassword': environment.get('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', ''),
            'publicKey': environment['GEOD_UPDATE_PUBLIC_KEY']}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--signed-update', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--installer-compression', choices=['lzma','zlib'], default='lzma')
    parser.add_argument('--signing-key-source', choices=['windows-vault','environment'], default='windows-vault')
    args = parser.parse_args()
    target = Path(args.output).resolve()
    if not target.is_relative_to(ROOT / 'artifacts') or not target.name.startswith('release-candidate-'):
        raise ValueError('Use a fresh release-candidate directory under artifacts.')
    source_config(DESKTOP / 'src-tauri')
    environment, trust = trust_environment(release_environment(os.environ), args.signed_update)
    signing_record = environment_signing_key(os.environ) if args.signed_update and not args.dry_run and args.signing_key_source == 'environment' else None
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
    settings = bundle_config(environment, args.signed_update, args.installer_compression)
    with tempfile.TemporaryDirectory(prefix='geod-release-build-') as temporary:
        config = Path(temporary) / 'build.json'
        config.write_text(json.dumps(settings), encoding='utf-8')
        subprocess.run([node, str(cli), 'build', '--ci', '--bundles', 'nsis', '--config', str(config)], cwd=DESKTOP, env=environment, check=True)
    identity = write_stamp(DESKTOP / 'src-tauri', DESKTOP / 'src-tauri/target/release')
    record = inventory(ROOT)
    public_env = public_environment(environment)
    subprocess.run([shutil.which('python') or 'python', '-X', 'utf8', str(ROOT / 'scripts/package-release-candidate.py'), str(target)], cwd=ROOT, env=public_env, check=True)
    record.update(updateChannel=trust, installerCompression=args.installer_compression, buildIdentity=identity, installed=False, published=False)
    if args.signed_update:
        record['updaterBundlerConfig'] = settings['plugins']['updater']
        record['signingMode'] = 'detached-cli-after-public-build'
    (target / 'build-receipt.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    if args.signed_update:
        installer = target / f"GeoD Agent_{record['version']}_x64-setup.exe"
        signer = sign_module()
        if signing_record is None:
            private, public = signer.candidate_key()
        else:
            private, public = signing_record, {'publicKey': signing_record['publicKey']}
            signing_record = None
        if public['publicKey'] != environment['GEOD_UPDATE_PUBLIC_KEY']:
            raise ValueError('The signing identity differs from the public build configuration.')
        signer.sign(installer, private, record['version'])
        del private
        subprocess.run([node, str(ROOT / 'scripts/update-candidate.mjs'), str(installer), record['version'], environment['GEOD_UPDATE_ARTIFACT_BASE'], str(target)], cwd=ROOT, env=public_env, check=True)
    print(json.dumps({'candidate': str(target), 'signedUpdate': trust['configured'], 'installed': False, 'published': False}))

if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
