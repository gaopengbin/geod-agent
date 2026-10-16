"""Resume a draft by uploading only missing assets; preserve conflicting releases."""
import argparse
import json
from pathlib import Path
import re
import subprocess
from release_flow import save, sha

REPO = 'gaopengbin/geod-agent'


def gh(*args):
    result = subprocess.run(['gh', *args], capture_output=True, encoding='utf-8',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('GitHub release command failed; check authentication/connectivity')
    return result.stdout


def publish(phase, plan_file, target, notes, receipt_file):
    if not re.fullmatch('[a-f0-9]{40}', target):
        raise ValueError('Pin a full release source commit')
    plan = json.loads(Path(plan_file).read_text(encoding='utf-8'))
    version, files = plan['version'], [Path(f) for f in plan['githubFiles']]
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected formal version')
    folder = Path(plan_file).resolve().parent
    if any(not f.resolve().is_relative_to(folder) or not f.is_file() for f in files):
        raise ValueError('Only staged public assets may be uploaded')
    expected = {f.name: {'bytes': f.stat().st_size, 'sha256': sha(f)} for f in files}
    tag = 'v' + version
    # A network/auth error must not be mistaken for a missing release.
    releases = json.loads(gh('api', f'repos/{REPO}/releases', '--paginate', '--slurp'))
    found = next((item for page in releases for item in page if item['tag_name'] == tag), None)
    if not found:
        if phase != 'stage':
            raise ValueError('Draft must be staged before publication')
        gh('release', 'create', tag, '--repo', REPO, '--target', target, '--draft',
           '--title', 'GeoD Agent ' + version, '--notes-file', str(notes))
    readback = json.loads(gh('release', 'view', tag, '--repo', REPO, '--json',
                            'url,isDraft,isPrerelease,assets,targetCommitish'))
    if readback['targetCommitish'] != target or readback['isPrerelease']:
        raise ValueError('Preserve existing release with another target or prerelease state')
    assets = {item['name']: item for item in readback['assets']}
    for name, asset in assets.items():
        if name not in expected or asset['size'] != expected[name]['bytes'] or asset.get('digest') != 'sha256:' + expected[name]['sha256']:
            raise ValueError('Preserve conflicting GitHub asset: ' + name)
    missing = [str(f) for f in files if f.name not in assets]
    if missing:
        if phase != 'stage' or not readback['isDraft']:
            raise ValueError('Public release is incomplete; do not modify it automatically')
        gh('release', 'upload', tag, '--repo', REPO, *missing)
        after = json.loads(gh('release', 'view', tag, '--repo', REPO, '--json', 'assets'))
        if any(f.name not in {a['name'] for a in after['assets']} for f in files):
            raise ValueError('GitHub upload did not finish; rerun to resume missing assets')
        return publish(phase, plan_file, target, notes, receipt_file)
    if phase == 'publish' and readback['isDraft']:
        gh('release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest')
        readback = json.loads(gh('release', 'view', tag, '--repo', REPO, '--json',
                                'url,isDraft,isPrerelease,assets,targetCommitish'))
        if readback['isDraft'] or readback['isPrerelease']:
            raise ValueError('Publication was not confirmed')
    result = {'passed': True, 'version': version, 'phase': phase, 'target': target,
              'publicPlanSha256': sha(plan_file), 'assets': expected, 'release': readback}
    save(receipt_file, result)
    return {'passed': True, 'version': version, 'assets': len(expected), 'isDraft': readback['isDraft']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['stage', 'publish'])
    for name in ('plan', 'notes', 'receipt'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    print(json.dumps(publish(args.phase, args.plan, args.target, args.notes, args.receipt)))
