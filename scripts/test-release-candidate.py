"""Real CLI signatures, real pinned resources, and candidate-only workflow checks."""
from pathlib import Path
import base64
import json
import os
import shutil
import subprocess
import tempfile
import yaml
from build_release_candidate_for_tests import load_builder
from release_inventory import runtime_directories, verify_runtime

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts/product-gaps-20261004/release-pipeline'
OUTPUT.mkdir(parents=True, exist_ok=True)
node = shutil.which('node')
cli = ROOT / 'apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js'
cases = []
with tempfile.TemporaryDirectory(prefix='geod-release-signature-qa-') as temporary:
    folder = Path(temporary)
    def signer(args):
        result = subprocess.run([node, str(cli), 'signer', *args], cwd=cli.parent, stdin=subprocess.DEVNULL, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError('Official Tauri signature fixture failed; no private output shown.')
    signer(['generate', '--ci', '--write-keys', str(folder / 'key')])
    signer(['generate', '--ci', '--write-keys', str(folder / 'other-key')])
    payload = folder / 'not-an-installer.bin'
    payload.write_bytes(b'Non executable update review fixture\n' + os.urandom(65536))
    signer(['sign', '--private-key-path', str(folder / 'key'), '--app-version', '0.2.1', str(payload)])
    signer(['sign', '--private-key-path', str(folder / 'key'), '--app-version', '0.2.1', str(payload)])
    public = (folder / 'key.pub').read_text(encoding='utf-8').strip()
    signature = Path(str(payload) + '.sig').read_text(encoding='utf-8').strip()
    trust_environment = load_builder().trust_environment
    env = {'GEOD_UPDATE_ENDPOINT': 'https://updates.example.test/latest.json', 'GEOD_UPDATE_PUBLIC_KEY': public, 'GEOD_UPDATE_ARTIFACT_BASE': 'https://updates.example.test/0.2.1', 'TAURI_SIGNING_PRIVATE_KEY': str(folder / 'key')}
    safe, trust = trust_environment(env, True)
    assert trust['configured'] and 'privateKey' not in trust
    no_keys, no_channel = trust_environment(env, False)
    assert not no_keys and not no_channel['configured']
    try:
        trust_environment({**env, 'GEOD_UPDATE_ENDPOINT': 'http://127.0.0.1/update'}, True)
        raise AssertionError('Unsigned transport passed release gate')
    except ValueError:
        pass
    cases.append({'name': 'Signed release trust preflight, HTTPS enforcement and unsigned secret exclusion', 'passed': True})
    state = {'payload': str(payload), 'public': public, 'signature': signature, 'otherPublic': (folder / 'other-key.pub').read_text(encoding='utf-8').strip()}
    (folder / 'public-state.json').write_text(json.dumps(state), encoding='utf-8')
    result = subprocess.run([node, str(ROOT / 'scripts/test-update-candidate.mjs'), str(folder / 'public-state.json'), str(OUTPUT)], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    cases.extend(json.loads((OUTPUT / 'signature-result.json').read_text(encoding='utf-8'))['cases'])
    small = folder / 'resource'
    small.mkdir()
    (small / 'real.txt').write_text('actual runtime record', encoding='utf-8')
    import hashlib
    digest = hashlib.sha256((small / 'real.txt').read_bytes()).hexdigest()
    (small / 'manifest.json').write_text(json.dumps({'files': {'real.txt': digest}}))
    assert verify_runtime(small)['filesVerified'] == 1
    (small / 'real.txt').write_text('altered record', encoding='utf-8')
    try:
        verify_runtime(small)
        raise AssertionError('Modified runtime passed packaging gate')
    except ValueError:
        pass
    names = [name for _, name in runtime_directories(ROOT)]
    assert set(names) == {'codex-runtime', 'python-runtime', 'pgedge-runtime', 'document-runtime', 'dbhub-runtime', 'audio-runtime'}
    cases.append({'name': 'Six base runtimes exclude GIS/Java/OCR and reject modified files', 'passed': True})
workflow = yaml.load((ROOT / '.github/workflows/release-candidate.yml').read_text(encoding='utf-8'), Loader=yaml.BaseLoader)
desktop_tools=json.loads((ROOT/'apps/geod-agent-desktop/src-tauri/codex-tools.json').read_text(encoding='utf-8'))
native_tools=json.loads((ROOT/'apps/geod-agent-desktop/src-tauri/native-tools.json').read_text(encoding='utf-8'))
assert len({tool['function']['name'] for tool in desktop_tools})==len(desktop_tools)
assert all(tool in desktop_tools for tool in native_tools)
assert {'attachment_list','attachment_read','sql_connections_list','sql_connection_connect','sql_objects_search','sql_query'} <= {tool['function']['name'] for tool in native_tools}
cases.append({'name':'Bundled snapshot preserves exact native document and SQL contracts alongside shared gateway tools','passed':True})
assert list(workflow['on']) == ['workflow_dispatch']
assert workflow['permissions'] == {'contents': 'read'}
assert 'TAURI_SIGNING_PRIVATE_KEY' not in workflow['jobs']['candidate']['env']
assert all(len(step['uses'].split('@')[1]) == 40 for step in workflow['jobs']['candidate']['steps'] if 'uses' in step)
assert not any('gh release' in step.get('run', '') for step in workflow['jobs']['candidate']['steps'])
cases.append({'name': 'Manual candidate workflow has pinned actions, step-only signing keys and no release publication', 'passed': True})
report = {'passed': True, 'cases': cases, 'installed': False, 'published': False, 'containsInstaller': False}
(OUTPUT / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'cases': len(cases), 'installed': False, 'published': False}))
