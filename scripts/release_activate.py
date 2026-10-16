"""Trusted Linux entrypoint, uploaded over pinned SSH with verified hashes."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile


def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def replace(file, data):
    temporary = file.with_name('.' + file.name + '.agent-pending')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o644)
    os.replace(temporary, file)


def select(current, target):
    temporary = current.with_name('.geod-website.agent-pending')
    if temporary.is_symlink() and temporary.resolve() == target:
        temporary.unlink()
    if temporary.exists() or temporary.is_symlink():
        raise ValueError('Preserve conflicting temporary pointer')
    temporary.symlink_to(target)
    os.replace(temporary, current)


def activate(stage, rollback=False, base=Path('/srv/laogao')):
    stage = Path(stage).resolve()
    if stage.parent != base / 'staging' or not stage.name.startswith('geod-agent-'):
        raise ValueError('Unsafe stage')
    plan = json.loads((stage / 'website-deploy-plan.json').read_text())
    old, new, backup = [Path(plan[k]) for k in ('previousWebsite', 'website', 'backup')]
    if any(not p.resolve().is_relative_to(base / 'releases/geod-website') for p in [old, new]) or new == old:
        raise ValueError('Unsafe site target')
    if backup.parent != base / 'backups':
        raise ValueError('Unsafe backup path')
    if plan['pages'] != ['agent.html', 'agent.txt', 'en/agent.html', 'en/agent.txt']:
        raise ValueError('Only the four Agent pages may be replaced')
    current = base / 'current/geod-website'
    manifest = base / 'packages/geod-agent-updates/windows-x86_64/latest.json'
    if rollback:
        if current.resolve() != new or sha(manifest) != plan['manifestSha256']:
            raise ValueError('Current pointers changed since this release')
        original = backup / 'latest-before.json'
        if sha(original) != plan['previousManifestSha256']:
            raise ValueError('Rollback index differs')
        replace(manifest, original.read_bytes())
        select(current, old)
        return {'passed': True, 'state': 'rolled_back'}
    receipt = stage / 'origin-result.json'
    if current.resolve() == new and sha(manifest) == plan['manifestSha256'] and receipt.exists():
        return json.loads(receipt.read_text())
    if not current.is_symlink() or current.resolve() not in [old, new]:
        raise ValueError('Website changed since preparation')
    if sha(manifest) not in [plan['previousManifestSha256'], plan['manifestSha256']]:
        raise ValueError('Index changed since preparation')
    if sha(stage / 'latest.json') != plan['manifestSha256'] or sha(stage / 'website-agent.tar.gz') != plan['archiveSha256']:
        raise ValueError('Uploaded origin files differ')
    if shutil.disk_usage(base).free < 2 * 1024**3:
        raise ValueError('Need 2 GiB free before site staging')
    backup.mkdir(exist_ok=True)
    original = backup / 'latest-before.json'
    if not original.exists():
        if sha(manifest) != plan['previousManifestSha256']:
            raise ValueError('Cannot recover the previous index from current state')
        shutil.copy2(manifest, original)
    if sha(original) != plan['previousManifestSha256']:
        raise ValueError('Preserve conflicting rollback data')
    # Copy once; a partial candidate directory is safe to finish on rerun.
    if current.resolve() != new:
        shutil.copytree(old, new, symlinks=True, dirs_exist_ok=True)
    baseline = {f.relative_to(old).as_posix(): sha(f) for f in old.rglob('*')
                if f.is_file() and f.relative_to(old).as_posix() not in plan['pages']}
    with tarfile.open(stage / 'website-agent.tar.gz') as archive:
        members = archive.getmembers()
        if len(members) != len(plan['files']) or {m.name for m in members} != set(plan['files']):
            raise ValueError('Unexpected site archive entries')
        for member in members:
            name = member.name
            if name not in plan['pages'] and not name.startswith('_next/static/'):
                raise ValueError('Only Agent pages and hashed static assets may change')
            target = new / name
            if not member.isfile() or not target.resolve().is_relative_to(new.resolve()):
                raise ValueError('Unsafe site archive member')
            data = archive.extractfile(member).read()
            expected = plan['files'][name]
            if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
                raise ValueError('Site file differs')
            if name in baseline and sha(target) != expected['sha256']:
                raise ValueError('Existing shared asset collision')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
    if any(sha(new / name) != expected for name, expected in baseline.items()):
        raise ValueError('Unrelated website files changed')
    replace(manifest, (stage / 'latest.json').read_bytes())
    select(current, new)
    result = {'passed': True, 'state': 'activated', 'version': plan['version'], 'website': str(new),
              'backup': str(backup), 'at': datetime.now(timezone.utc).isoformat()}
    replace(receipt, json.dumps(result).encode())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, type=Path)
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    import fcntl
    with (args.stage.parent / '.geod-agent-release.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(activate(args.stage, args.rollback)))
