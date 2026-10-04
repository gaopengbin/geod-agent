"""Read the same resource map Tauri uses, instead of a second hard-coded list."""
from pathlib import Path
import hashlib
import json
import tomllib

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def runtime_directories(repo):
    native = repo / 'apps/geod-agent-desktop/src-tauri'
    config = json.loads((native / 'tauri.conf.json').read_text(encoding='utf-8'))
    result = []
    for source, destination in config['bundle']['resources'].items():
        if not source.endswith('/'):
            continue
        root = (native / source).resolve()
        relative = Path(destination)
        if not root.is_relative_to(repo.resolve()) or relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Runtime resource must stay in the repository and package.')
        result.append((root, destination.rstrip('/')))
    return result

def verify_runtime(folder):
    folder = folder.resolve()
    manifest_path = folder / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not isinstance(manifest.get('files'), dict) or not manifest['files']:
        raise ValueError('Runtime file manifest is empty or invalid: ' + folder.name)
    for name, entry in manifest['files'].items():
        expected = entry['sha256'] if isinstance(entry, dict) else entry
        target = (folder / name).resolve()
        if not target.is_relative_to(folder) or not target.is_file() or digest(target) != expected:
            raise ValueError('Runtime checksum mismatch: ' + folder.name + '/' + name)
    return {'filesVerified': len(manifest['files']), 'manifestSha256': digest(manifest_path)}

def inventory(repo):
    desktop = repo / 'apps/geod-agent-desktop'
    native = desktop / 'src-tauri'
    version = json.loads((native / 'tauri.conf.json').read_text(encoding='utf-8'))['version']
    if version != json.loads((desktop / 'package.json').read_text(encoding='utf-8'))['version'] or version != tomllib.loads((native / 'Cargo.toml').read_text(encoding='utf-8'))['package']['version']:
        raise ValueError('Frontend, native crate and Tauri versions must match.')
    return {'version': version, 'platform': 'windows-x86_64', 'runtimes': {name: verify_runtime(source) for source, name in runtime_directories(repo)}}

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    output = Path(args.output).resolve()
    if not output.is_relative_to(repo / 'artifacts'):
        raise SystemExit('Inventory belongs in repository artifacts.')
    result = inventory(repo)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'verified': True, 'version': result['version'], 'runtimes': len(result['runtimes']), 'files': sum(v['filesVerified'] for v in result['runtimes'].values())}))
