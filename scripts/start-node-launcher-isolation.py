"""Start the real dev app with no system Node/npm/Python tools on its PATH."""
from pathlib import Path
import json
import os
import subprocess
import sys
import shutil

root = Path(__file__).resolve().parents[1]
directory = root / 'artifacts/product-gaps-20261004/plugin-node-launchers'
environment = dict(os.environ)
environment['PATH'] = os.pathsep.join([str(Path(sys.executable).parent), str(Path(os.environ['SystemRoot']) / 'System32')])
resolved_tools = {name: shutil.which(name, path=environment['PATH']) for name in ['node', 'npm', 'npx']}
if any(resolved_tools.values()):
    raise SystemExit('Scoped isolation still exposes a system Node/npm launcher')
for name in ['GEOD_CODEX_NODE', 'GEOD_CODEX_EXE', 'NODE_PATH', 'NPM_CONFIG_PREFIX']:
    environment.pop(name, None)
result = subprocess.run([sys.executable, '-X', 'utf8', str(root / 'scripts/start-codex-dev.py'), '--local-gateway'], env=environment, cwd=root, capture_output=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
(directory / 'isolated-start.log').write_text(result.stdout+'\n'+result.stderr, encoding='utf-8')
if result.returncode:
    raise SystemExit(result.stderr)
(directory / 'isolation.json').write_text(json.dumps({'started': True, 'path': environment['PATH'], 'resolvedSystemTools': resolved_tools, 'systemNodeOnPath': False, 'systemNpmOnPath': False, 'scope': 'Child process environment only; global PATH unchanged'}, indent=2), encoding='utf-8')
print('Actual development desktop started with scoped PATH isolation')
