"""Real signing/HTTP/SDK/component-cache acceptance; never execute an installer."""
from pathlib import Path
import copy
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from component_updates import archive_runtime
from release_inventory import runtime_directories

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts/component-updates-20261012'
OUTPUT.mkdir(parents=True, exist_ok=True)
CLI = ROOT / 'apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js'
NATIVE = ROOT / 'apps/geod-agent-desktop/src-tauri'
requests = []


with tempfile.TemporaryDirectory(prefix='geod-components-qa-', dir=OUTPUT) as temporary:
    fixture = Path(temporary)
    resources = fixture / 'resources'
    key = fixture / 'key'

    def signer(arguments):
        result = subprocess.run([shutil.which('node'), str(CLI), 'signer', *arguments], stdin=subprocess.DEVNULL, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise RuntimeError('QA signer failed; private output withheld')

    signer(['generate', '--ci', '--write-keys', str(key)])

    def signed(file, version='0.2.5'):
        signer(['sign', '--private-key-path', str(key), '--app-version', version, str(file)])
        return Path(str(file) + '.sig').read_text(encoding='utf-8').strip()

    payloads = {}
    manifests = {}
    indexes = {}

    def descriptor(file, url_name=None, version='0.2.5'):
        signature = signed(file, version)
        data = file.read_bytes()
        name = url_name or file.name
        payloads[name] = data
        return {'url': name, 'signature': signature, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    packages = []
    for source, id in runtime_directories(ROOT):
        id = id.rstrip('/')
        target = resources / id
        manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
        for name in [*manifest['files'], 'manifest.json']:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Same pinned bytes, separate directory; no source file is edited.
            os.link(source / name, destination)
        archive = fixture / (id + '.tar.gz')
        sha, installed = archive_runtime(target, archive)
        packages.append({'id': id, 'manifestSha256': sha, 'installedBytes': installed, 'artifact': descriptor(archive)})
    application = fixture / 'application.bin'
    application.write_bytes(b'Signed application acceptance bytes. Never install or execute.\n')
    full = fixture / 'full.bin'
    full.write_bytes(b'Signed legacy full-installer acceptance bytes. Never execute.\n')
    app_artifact, full_artifact = descriptor(application), descriptor(full)

    def changed(id, suffix):
        source = fixture / suffix
        source.mkdir()
        data = ('New component acceptance fixture ' + suffix).encode()
        (source / 'engine.bin').write_bytes(data)
        (source / 'manifest.json').write_text(json.dumps({'files': {'engine.bin': hashlib.sha256(data).hexdigest()}}), encoding='utf-8')
        archive = fixture / (suffix + '.tar.gz')
        sha, installed = archive_runtime(source, archive)
        return {'id': id, 'manifestSha256': sha, 'installedBytes': installed, 'artifact': descriptor(archive)}

    python_changed = changed('python-runtime', 'changed-python')
    broken_audio = changed('audio-runtime', 'broken-audio')
    truncated_audio = changed('audio-runtime', 'truncated-audio')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            requests.append(self.path)
            if self.path.startswith('/manifest/'):
                name = self.path.split('/')[-1]
                if name not in manifests:
                    self.send_error(404)
                    return
                data = json.dumps(manifests[name]).encode()
            else:
                name = self.path.lstrip('/')
                data = payloads.get(name)
                if data is None:
                    self.send_error(404)
                    return
            self.send_response(200)
            self.send_header('Content-Length', len(data) + (100 if self.path == '/truncated-audio.tar.gz' else 0))
            self.end_headers()
            self.wfile.write(data)
            if self.path == '/truncated-audio.tar.gz':
                self.close_connection = True

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    origin = 'http://127.0.0.1:' + str(server.server_port)
    for artifact in [app_artifact, full_artifact, *[p['artifact'] for p in packages], python_changed['artifact'], broken_audio['artifact'], truncated_audio['artifact']]:
        artifact['url'] = origin + '/' + artifact['url']
    for name in ['unchanged', 'retry-cached', 'changed-one', 'missing-one', 'tampered-index', 'wrong-version-index', 'tampered-archive', 'truncated-archive', 'legacy-full', 'future-schema-full']:
        index = {'schema': 1, 'version': '0.2.5', 'platform': 'windows-x86_64', 'application': app_artifact, 'runtimes': copy.deepcopy(packages)}
        replacement = {'changed-one': python_changed, 'tampered-archive': broken_audio, 'truncated-archive': truncated_audio}.get(name)
        if replacement:
            index['runtimes'] = [replacement if p['id'] == replacement['id'] else p for p in index['runtimes']]
        if name == 'future-schema-full':
            index['schema'] = 2
        file = fixture / (name + '.json')
        file.write_text(json.dumps(index), encoding='utf-8')
        pointer = descriptor(file, version='0.2.6' if name == 'wrong-version-index' else '0.2.5')
        pointer['url'] = origin + '/' + pointer['url']
        if name == 'tampered-index':
            payloads[file.name] += b' '
            pointer['bytes'] += 1
            pointer['sha256'] = hashlib.sha256(payloads[file.name]).hexdigest()
        manifests[name] = {'version': '0.2.5', 'platforms': {'windows-x86_64': {'url': full_artifact['url'], 'signature': full_artifact['signature']}}}
        if name != 'legacy-full':
            manifests[name]['componentUpdate'] = pointer
    payloads['broken-audio.tar.gz'] += b'corrupted after signing'
    key.unlink()  # No private key is needed while running the actual downloader.
    config = {'origin': origin, 'pubkey': key.with_suffix('.pub').read_text(encoding='utf-8').strip(), 'cache': str(fixture / 'cache'), 'resources': str(resources), 'result': str(OUTPUT / 'sdk-acceptance.json')}
    config_path = fixture / 'public.json'
    config_path.write_text(json.dumps(config), encoding='utf-8')
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        executable = NATIVE / 'target/debug/examples/component_update_acceptance.exe'
        completed = subprocess.run([str(executable), str(config_path)], capture_output=True, timeout=240, creationflags=subprocess.CREATE_NO_WINDOW)
        if completed.returncode:
            raise RuntimeError(completed.stdout.decode('utf-8', errors='replace') + completed.stderr.decode('utf-8', errors='replace'))
    finally:
        server.shutdown()
        server.server_close()
    result = json.loads((OUTPUT / 'sdk-acceptance.json').read_text(encoding='utf-8'))
    # The first two updates must not request even a single runtime archive.
    first_change = requests.index('/manifest/changed-one')
    assert not any(path.endswith('.tar.gz') for path in requests[:first_change])
    assert requests.count('/changed-python.tar.gz') == 1
    assert requests.count('/python-runtime.tar.gz') == 1
    assert requests.count('/full.bin') == 2  # Legacy/unknown future protocol; ordinary new updates use application.bin.
    result.update(requests=requests, zeroRuntimeDownloadsWhenUnchanged=True, changedRuntimeDownloads=1,
                  corruptSignaturesRejected=True, productionAccountUsed=False, creditsConsumed=0)
    (OUTPUT / 'sdk-acceptance.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k not in ('requests', 'cases')}))
