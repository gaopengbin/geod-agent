"""Batch pinned SCP/SSH site and canonical index activation; no server downloads."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
from release_flow import save, sha

HOST = 'ubuntu@62.234.147.130'
HOME = Path.home()
OPTIONS = ['-i', str(HOME / '.ssh/laogao_tencent_ed25519'), '-o', 'BatchMode=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
           '-o', 'UserKnownHostsFile=' + str(HOME / '.codex/skills/laogao-tencent-deploy/references/known_hosts')]
PAGES = ['agent.html', 'agent.txt', 'en/agent.html', 'en/agent.txt']


def ssh(command, stdin=None):
    result = subprocess.run(['ssh.exe', *OPTIONS, HOST, command], input=stdin, capture_output=True,
                            encoding='utf-8', timeout=180,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('Pinned SSH release operation failed; inspect the server release receipt')
    return result.stdout


def prepare(site, latest, output, release_id):
    if not re.fullmatch(r'geod-agent-[a-z0-9.-]+', release_id):
        raise ValueError('Use a unique geod-agent release ID')
    site, latest, output = Path(site).resolve(), Path(latest).resolve(), Path(output).resolve()
    version = json.loads(latest.read_text(encoding='utf-8'))['version']
    files = {name: site / name for name in PAGES}
    files.update({p.relative_to(site).as_posix(): p for p in (site / '_next/static').rglob('*') if p.is_file()})
    if any(not f.is_file() or f.is_symlink() or not f.resolve().is_relative_to(site) for f in files.values()):
        raise ValueError('Unsafe/incomplete static Agent site build')
    for name in ['agent.html', 'en/agent.html']:
        data = files[name].read_text(encoding='utf-8')
        if '/'+version+'/' not in data or 'download.laogao.xyz' not in data:
            raise ValueError('Agent site does not reference this version')
    # Only one read-only server round-trip for both previous pointers.
    snapshot = json.loads(ssh('python3 -', "from pathlib import Path\nimport hashlib,json\np=Path('/srv/laogao/packages/geod-agent-updates/windows-x86_64/latest.json')\nprint(json.dumps({'website':str(Path('/srv/laogao/current/geod-website').resolve()),'manifestSha256':hashlib.sha256(p.read_bytes()).hexdigest()}))\n"))
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'website-agent.tar.gz'
    with tarfile.open(archive, 'w:gz') as stream:
        for name, file in sorted(files.items()):
            stream.add(file, arcname=name, recursive=False)
    plan = {'version': version, 'pages': PAGES,
            'files': {name: {'bytes': file.stat().st_size, 'sha256': sha(file)} for name, file in files.items()},
            'archiveSha256': sha(archive), 'manifestSha256': sha(latest),
            'previousWebsite': snapshot['website'], 'previousManifestSha256': snapshot['manifestSha256'],
            'website': '/srv/laogao/releases/geod-website/' + release_id,
            'backup': '/srv/laogao/backups/' + release_id, 'stage': '/srv/laogao/staging/' + release_id}
    save(output / 'website-deploy-plan.json', plan)
    return {'passed': True, 'files': len(files), 'archiveBytes': archive.stat().st_size}


def activate(output, latest):
    output, latest = Path(output).resolve(), Path(latest).resolve()
    plan = json.loads((output / 'website-deploy-plan.json').read_text(encoding='utf-8'))
    stage = plan['stage']
    if not re.fullmatch(r'/srv/laogao/staging/geod-agent-[a-z0-9.-]+', stage):
        raise ValueError('Unsafe remote staging path')
    script = Path(__file__).with_name('release_activate.py')
    inputs = [output / 'website-agent.tar.gz', output / 'website-deploy-plan.json', latest, script]
    if latest.name != 'latest.json' or sha(latest) != plan['manifestSha256'] or sha(inputs[0]) != plan['archiveSha256']:
        raise ValueError('Origin activation inputs changed')
    ssh('mkdir -p ' + shlex.quote(stage))
    result = subprocess.run(['scp.exe', *OPTIONS, *map(str, inputs), HOST + ':' + stage + '/'],
                            capture_output=True, timeout=180,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('Pinned SCP failed; pointers were not switched')
    # Verify every upload, including the executable control script, before using it.
    checks = {file.name: sha(file) for file in inputs}
    payload = 'from pathlib import Path\nimport hashlib,subprocess\np=Path(' + repr(stage) + ')\n'
    payload += 'checks=' + repr(checks) + '\n'
    payload += "for n,h in checks.items():\n assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h\n"
    payload += "subprocess.run(['python3',str(p/'release_activate.py'),'--stage',str(p)],check=True)\n"
    record = json.loads(ssh('python3 -', payload))
    save(output / 'origin-activation.json', record)
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'activate'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--latest', required=True, type=Path)
    parser.add_argument('--site', type=Path)
    parser.add_argument('--release-id')
    args = parser.parse_args()
    if args.phase == 'prepare' and (not args.site or not args.release_id):
        parser.error('prepare needs --site and --release-id')
    print(json.dumps(prepare(args.site, args.latest, args.output, args.release_id)
                     if args.phase == 'prepare' else activate(args.output, args.latest)))
