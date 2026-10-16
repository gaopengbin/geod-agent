"""Verify the extracted installer once per exact installer/payload fingerprint."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from release_flow import save, sha
from release_inventory import verify_runtime


def verify(candidate, receipt):
    candidate = Path(candidate)
    record = json.loads((candidate / 'candidate.json').read_text(encoding='utf-8'))
    version = record['version']
    installer = candidate / f'GeoD Agent_{version}_x64-setup.exe'
    if sha(installer) != record['artifacts'][installer.name]['sha256']:
        raise ValueError('Installer differs from candidate')
    payload = candidate / 'installer-payload'
    if not payload.exists():
        # A newly built candidate has not been unpacked by earlier QA runs.
        # Extract our hash-verified installer; never install or overwrite it.
        subprocess.run([sys.executable, '-X', 'utf8', str(Path(__file__).with_name('extract-release-candidate.py')),
                        str(candidate.resolve())], check=True)
    portable = candidate / f'GeoD-Agent-{version}-windows-x64/geod-agent-desktop.exe'
    installed = (payload / 'geod-agent-desktop.exe').read_bytes()
    portable_bytes = portable.read_bytes()
    first, second = b'__TAURI_BUNDLE_TYPE_VAR_NSS', b'__TAURI_BUNDLE_TYPE_VAR_UNK'
    if sha(portable) != record['mainExecutableSha256'] or installed.count(first) != 1 or portable_bytes.count(second) != 1 or installed.replace(first, second) != portable_bytes:
        raise ValueError('Executable differs beyond expected Tauri bundle marker')
    checks = {}
    for name, expected in record['runtimeVerification'].items():
        check = verify_runtime(payload / name)
        if any(check[key] != expected[key] for key in ('manifestSha256', 'filesVerified')):
            raise ValueError('Installer runtime differs: ' + name)
        checks[name] = check
    result = {'passed': True, 'version': version, 'installerSha256': sha(installer), 'runtimes': checks,
              'runtimeFilesVerified': sum(item['filesVerified'] for item in checks.values()),
              'installed': False, 'freshWindowsVerified': False}
    save(receipt, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('receipt', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.candidate, args.receipt)))
