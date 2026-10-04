"""Verify the actual installer payload, rather than only prepared source files."""
from pathlib import Path
import argparse
import hashlib
import json

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
output = Path(parser.parse_args().output).resolve()
assert output.is_relative_to(repo/'artifacts') and output.name.startswith('release-candidate-')
candidate = json.loads((output/'candidate.json').read_text(encoding='utf-8'))
payload = output/'installer-payload'
portable = output/f"GeoD-Agent-{candidate['version']}-windows-x64"
def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
exe = (payload/'geod-agent-desktop.exe').read_bytes()
installed_marker = b'__TAURI_BUNDLE_TYPE_VAR_NSS'
portable_marker = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
assert exe.count(installed_marker) == 1 and exe.count(portable_marker) == 0
assert hashlib.sha256(exe.replace(installed_marker, portable_marker)).hexdigest() == candidate['mainExecutableSha256']
verified = {}
for name, metadata in candidate['runtimeVerification'].items():
    folder = payload/name
    assert sha(folder/'manifest.json') == metadata['manifestSha256']
    manifest = json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
    for relative, spec in manifest['files'].items():
        file = (folder/relative).resolve()
        assert file.is_relative_to(folder.resolve())
        assert sha(file) == (spec if isinstance(spec, str) else spec['sha256'])
    verified[name] = len(manifest['files'])
    assert verified[name] == metadata['filesVerified']
assert len(verified) == 8
assert sha(portable/'geod-agent-desktop.exe') == candidate['mainExecutableSha256']
report = dict(passed=True, version=candidate['version'], runtimes=verified,
              filesVerified=sum(verified.values()), installerExecutableSha256=sha(payload/'geod-agent-desktop.exe'),
              executableDifference='Only the Tauri NSIS bundle marker', installed=False, published=False,
              cleanWindowsVerified=False)
(output/'integrated-payload.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
