"""Run a reviewed release recipe; resume only when inputs AND outputs still match.

No shell, no cloud operations in dry-run, no blanket reuse based on a Git commit.
Separate compile and bundle steps must be sequential (they share Cargo outputs).
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.pending')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


@contextmanager
def lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.write(descriptor, b'0')
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)  # OS releases lock even when a publisher crashes.


def expand_files(root, patterns):
    files = {}
    for pattern in patterns:
        matches = list(root.glob(pattern))
        if not matches:
            raise ValueError('Missing release input/output: ' + pattern)
        for item in matches:
            descendants = item.rglob('*') if item.is_dir() else [item]
            for file in descendants:
                if file.is_file():
                    if file.is_symlink() or not file.resolve().is_relative_to(root):
                        raise ValueError('Release paths must stay in the repository')
                    files[file.relative_to(root).as_posix()] = sha(file)
    return files


def run(recipe, dry_run=False, until=None):
    root = Path(recipe['root']).resolve()
    state = root / recipe['state']
    if not state.resolve().is_relative_to(root):
        raise ValueError('Release state must be inside the repository')
    steps = recipe['steps']
    names = [step['id'] for step in steps]
    if len(set(names)) != len(names) or (until and until not in names):
        raise ValueError('Invalid or duplicated step IDs')
    if dry_run:
        # Deliberately no mkdir, child commands, hashing, requests or SDK init.
        return {'dryRun': True, 'steps': [{k: step.get(k) for k in ('id', 'effect', 'command')}
                                        for step in steps], 'largeCdnDownloads': 0}
    state.mkdir(parents=True, exist_ok=True)
    with lock(root / 'artifacts/release-publisher.lock'):
        journal_file = state / 'journal.json'
        journal = json.loads(journal_file.read_text(encoding='utf-8')) if journal_file.exists() else {'steps': {}}
        for step in steps:
            identity = step['id']
            if not identity.replace('-', '').replace('_', '').isalnum():
                raise ValueError('Invalid step ID')
            command = step['command']
            if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
                raise ValueError('Use an argument list, never a shell command')
            if not step.get('inputs') or not step.get('outputs'):
                raise ValueError('Each step needs explicit inputs and outputs')
            cwd = (root / step.get('cwd', '.')).resolve()
            if not cwd.is_relative_to(root):
                raise ValueError('Step cwd must stay in repository')
            inputs = expand_files(root, step['inputs'])
            for name in step.get('externalInputs', []):
                external = Path(name).resolve()
                if not external.exists() or external.is_symlink():
                    raise ValueError('Missing/unsafe external release input')
                for file in external.rglob('*') if external.is_dir() else [external]:
                    if file.is_file():
                        if file.is_symlink() or not file.resolve().is_relative_to(external if external.is_dir() else external.parent):
                            raise ValueError('Unsafe external release input')
                        inputs[str(file)] = sha(file)
            fingerprint = hashlib.sha256(json.dumps([command, str(cwd), inputs], sort_keys=True).encode()).hexdigest()
            previous = journal['steps'].get(identity, {})
            cached = False
            if step.get('reuse', True) and previous.get('passed') and previous.get('fingerprint') == fingerprint:
                try:
                    cached = expand_files(root, step['outputs']) == previous.get('outputs')
                except ValueError:
                    pass
            if cached:
                print(json.dumps({'step': identity, 'state': 'reused', 'secondsSaved': previous['seconds']}), flush=True)
            else:
                started = time.monotonic()
                entry = {'passed': False, 'fingerprint': fingerprint,
                         'startedAt': datetime.now(timezone.utc).isoformat()}
                journal['steps'][identity] = entry
                save(journal_file, journal)
                print(json.dumps({'step': identity, 'state': 'running'}), flush=True)
                # COS secrets belong only in the uploader, never in build children.
                environment = os.environ.copy()
                if step.get('effect', 'local') == 'local':
                    from update_signing_vault import public_environment
                    environment = public_environment()
                    for key in list(environment):
                        if key.startswith(('COS_SECRET', 'COS_SESSION', 'TENCENT_SECRET')):
                            environment.pop(key)
                log = state / (identity + '.log')
                try:
                    with log.open('wb') as stream:
                        result = subprocess.run(command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                                stdout=stream, stderr=subprocess.STDOUT,
                                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    entry.update(exitCode=result.returncode, seconds=round(time.monotonic() - started, 2))
                    if result.returncode:
                        raise ValueError('Release step failed: ' + identity + '; see ' + str(log))
                    entry.update(outputs=expand_files(root, step['outputs']), passed=True)
                finally:
                    save(journal_file, journal)
                print(json.dumps({'step': identity, 'state': 'complete', 'seconds': entry['seconds']}), flush=True)
            if identity == until:
                break
        return {'passed': True, 'journal': str(journal_file), 'stoppedAfter': until}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recipe', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--until')
    args = parser.parse_args()
    try:
        print(json.dumps(run(json.loads(args.recipe.read_text(encoding='utf-8')), args.dry_run, args.until)))
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
