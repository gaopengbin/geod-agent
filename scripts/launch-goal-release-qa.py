"""Launch only this reviewed candidate's portable directory on a stock PATH."""
from pathlib import Path
import argparse
import json
import os
import subprocess
import winreg
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--production', action='store_true', help='Verify the application default service addresses, without a gateway override.')
args = parser.parse_args()
output = Path(args.output).resolve()
assert output.is_relative_to(ROOT / 'artifacts') and output.name.startswith('release-candidate-')
manifest = json.loads((output / 'candidate.json').read_text(encoding='utf-8'))
bundle = output / f"GeoD-Agent-{manifest['version']}-windows-x64"
executable = bundle / 'geod-agent-desktop.exe'
assert executable.is_file() and bundle.resolve().is_relative_to(output)
startup = output / 'startup-before-qa.json'
if not startup.exists():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run') as key:
        try:
            value, value_type = winreg.QueryValueEx(key, 'GeoD Agent')
            record = {'exists': True, 'value': value, 'type': value_type}
        except FileNotFoundError:
            record = {'exists': False}
    startup.write_text(json.dumps(record), encoding='utf-8')
environment = {key: value for key, value in os.environ.items() if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMSPEC'}}
windows = Path(os.environ['SYSTEMROOT'])
environment['PATH'] = os.pathsep.join(map(str, [windows / 'System32', windows / 'System32/WindowsPowerShell/v1.0', windows]))
if not args.production:
    environment['GEOD_AGENT_GATEWAY_ORIGIN'] = 'http://127.0.0.1:43123'
environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--remote-debugging-port=9234'
with (output / 'native-qa.log').open('ab') as log:
    process = subprocess.Popen([str(executable)], cwd=bundle, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
print(json.dumps({'launched': True, 'pid': process.pid, 'stockWindowsPath': True, 'defaultProductionServices': args.production}))
