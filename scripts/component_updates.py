"""Produce independently signed runtimes plus a small NSIS application installer.

The ordinary latest.json platform remains the complete installer for old clients.
New clients verify the version-bound index before using any component URLs.
"""
from pathlib import Path
import copy
import gzip
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import urlsplit, quote
from release_inventory import runtime_directories, verify_runtime

IDS = {'codex-runtime', 'pgedge-runtime', 'document-runtime', 'dbhub-runtime', 'audio-runtime', 'python-runtime'}


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def artifact(file, base):
    url = urlsplit(base)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Component download base requires HTTPS without credentials')
    return {'url': base.rstrip('/') + '/' + quote(file.name), 'signature': Path(str(file) + '.sig').read_text(encoding='utf-8').strip(),
            'bytes': file.stat().st_size, 'sha256': digest(file)}


def archive_runtime(source, destination):
    verified = verify_runtime(source)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    files = sorted([*manifest['files'], 'manifest.json'])
    for name in files:
        if not name or '\\' in name or ':' in name or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError('Unsafe runtime archive path')
        file = source / name
        if file.is_symlink() or not file.resolve().is_relative_to(source.resolve()):
            raise ValueError('Runtime archive must contain regular pinned files')
    # Stable gzip/tar metadata allows identical components to retain identical bytes.
    with destination.open('wb') as output, gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=6) as zipped, tarfile.open(fileobj=zipped, mode='w', format=tarfile.GNU_FORMAT) as archive:
        for name in files:
            file = source / name
            info = tarfile.TarInfo(name)
            info.size = file.stat().st_size
            info.mode = 0o644
            with file.open('rb') as stream:
                archive.addfile(info, stream)
    return verified['manifestSha256'], sum((source / name).stat().st_size for name in files)


def bundle_application(repo, output, environment, config):
    desktop = repo / 'apps/geod-agent-desktop'
    release = desktop / 'src-tauri/target/release'
    version = json.loads((desktop / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
    installer = release / f'bundle/nsis/GeoD Agent_{version}_x64-setup.exe'
    original = installer.read_bytes()
    main_sha = digest(release / 'geod-agent-desktop.exe')
    # An array replaces the default resource map, rather than merging and quietly
    # retaining all large runtimes. License files remain in both distributions.
    small = copy.deepcopy(config)
    small.setdefault('bundle', {})['resources'] = ['../../../LICENSE', '../THIRD_PARTY_NOTICES.md']
    with tempfile.TemporaryDirectory(prefix='geod-component-bundle-') as temporary:
        override = Path(temporary) / 'bundle.json'
        override.write_text(json.dumps(small), encoding='utf-8')
        try:
            subprocess.run([shutil.which('node'), str(desktop / 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--bundles', 'nsis', '--no-binary-patching', '--config', str(override)], cwd=desktop, env=environment, check=True)
            if digest(release / 'geod-agent-desktop.exe') != main_sha:
                raise ValueError('Component bundling changed the reviewed application executable')
            target = output / f'GeoD-Agent-{version}-application-update.exe'
            shutil.copy2(installer, target)
        finally:
            installer.write_bytes(original)
    return target


def package_components(repo, output, application, version, base, sign):
    sources = [(source, name) for source, name in runtime_directories(repo)]
    if {name for _, name in sources} != IDS:
        raise ValueError('The runtime catalog and packaged resources disagree')
    sign(application, version)
    packages = []
    for source, name in sources:
        manifest_sha = digest(source / 'manifest.json')
        archive = output / f'{name}-{manifest_sha}.tar.gz'
        sha, size = archive_runtime(source, archive)
        sign(archive, version)
        packages.append({'id': name, 'manifestSha256': sha, 'installedBytes': size, 'artifact': artifact(archive, base)})
    index = {'schema': 1, 'version': version, 'platform': 'windows-x86_64', 'application': artifact(application, base), 'runtimes': packages}
    file = output / 'component-update.json'
    file.write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    sign(file, version)
    manifest_file = output / 'latest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    if manifest['version'] != version:
        raise ValueError('Component and full installer versions differ')
    manifest['componentUpdate'] = artifact(file, base)
    manifest_file.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    receipt = {'version': version, 'applicationBytes': application.stat().st_size,
               'runtimeArchivesBytes': sum(p['artifact']['bytes'] for p in packages), 'components': len(packages),
               'unchangedRuntimesDownloadBytes': 0, 'oldClientFullInstallerPreserved': True, 'published': False}
    (output / 'component-update-receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    return receipt
