"""Prepare an explicit public allowlist from locally verified signed descriptors."""
import argparse
import json
from pathlib import Path
import shutil
from urllib.parse import unquote, urlsplit
from release_flow import save, sha


def prepare(candidate, output, signatures, notes):
    candidate, output = Path(candidate).resolve(), Path(output).resolve()
    latest = json.loads((candidate / 'latest.json').read_text(encoding='utf-8'))
    version = latest['version']
    index = json.loads((candidate / 'component-update.json').read_text(encoding='utf-8'))
    verified = json.loads(Path(signatures).read_text(encoding='utf-8'))
    if verified.get('passed') is not True or verified['version'] != version or index['version'] != version:
        raise ValueError('Local signed artifact verification is required')
    descriptors = [latest['platforms']['windows-x86_64'], latest['componentUpdate'], index['application']]
    descriptors.extend(item['artifact'] for item in index['runtimes'])
    checks = {item['name']: item for item in verified['checks']}
    names = set()
    for item in descriptors:
        url = urlsplit(item['url'])
        name = unquote(Path(url.path).name)
        if url.scheme != 'https' or url.netloc != 'download.laogao.xyz' or url.query or url.fragment:
            raise ValueError('Use the reviewed CDN base before signing')
        if url.path.rsplit('/', 1)[0] != '/agent-updates/windows-x86_64/' + version:
            raise ValueError('Descriptor version path differs')
        file = candidate / name
        if '/' in name or '\\' in name or '..' in name or name not in checks or sha(file) != checks[name]['sha256']:
            raise ValueError('Signature receipt is stale or contains unsafe names')
        if (candidate / (name + '.sig')).read_text(encoding='utf-8').strip() != item['signature']:
            raise ValueError('Detached signature differs from the signed descriptor')
        names.update([name, name + '.sig'])
    record = json.loads((candidate / 'candidate.json').read_text(encoding='utf-8'))
    portable = f'GeoD-Agent-{version}-windows-x64.zip'
    if record['version'] != version or sha(candidate / portable) != record['artifacts'][portable]['sha256']:
        raise ValueError('Portable package differs from build receipt')
    names.add(portable)
    latest['notes'] = Path(notes).read_text(encoding='utf-8')
    # The signed component index and all its URLs remain byte-for-byte intact.
    output.mkdir(parents=True, exist_ok=True)
    save(output / 'latest.json', latest)
    cos, github = output / ('cos-' + version), output / ('github-' + version)
    for folder in [cos, github]:
        folder.mkdir(exist_ok=True)
        expected = {name.replace('GeoD Agent_', 'GeoD.Agent_') if folder == github else name for name in names}
        expected.update(['latest.json', 'SHA256SUMS-release.txt'])
        if any(file.name not in expected for file in folder.iterdir()):
            raise ValueError('Public staging folder contains extra files')
        for name in sorted(names):
            target_name = name.replace('GeoD Agent_', 'GeoD.Agent_') if folder == github else name
            target = folder / target_name
            if not target.exists() or sha(target) != sha(candidate / name):
                shutil.copy2(candidate / name, target)
        shutil.copy2(output / 'latest.json', folder / 'latest.json')
        (folder / 'SHA256SUMS-release.txt').write_text(''.join(sha(file) + '  ' + file.name + '\n'
            for file in sorted(folder.iterdir()) if file.name != 'SHA256SUMS-release.txt'), encoding='utf-8')
    objects = [{'name': f.name, 'key': f'agent-updates/windows-x86_64/{version}/{f.name}',
                'bytes': f.stat().st_size, 'sha256': sha(f),
                'cacheControl': 'public, immutable, max-age=31536000'} for f in sorted(cos.iterdir())]
    plan = {'version': version, 'objects': objects, 'cosFiles': [str(cos / i['name']) for i in objects],
            'githubFiles': [str(f) for f in sorted(github.iterdir())], 'mutableLatest': str(output / 'latest.json')}
    save(output / 'public-objects.json', plan)
    return {'passed': True, 'version': version, 'objects': len(objects), 'largeCdnDownloads': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('candidate', 'output', 'signatures', 'notes'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.candidate, args.output, args.signatures, args.notes)))
