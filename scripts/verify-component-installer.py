"""Exercise NSIS /UPDATE in an isolated QA identity and installation directory.

Never launches the installed app; leaves production registration/profile untouched.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import winreg

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'artifacts/component-updates-20261012/installer-qa-final'
INSTALL = OUTPUT / 'installed'
assert INSTALL.resolve().is_relative_to((ROOT / 'artifacts').resolve())
PRODUCT = 'GeoD Component Update QA Final 20261012'
IDENTIFIER = 'dev.geod-agent.component-install-qa-final-20261012'
REGKEYS = ['Software\\geod-agent\\' + PRODUCT, 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + PRODUCT]
resume = '--resume' in sys.argv[1:]
for key in REGKEYS:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            if not resume or key != REGKEYS[0] or winreg.QueryValueEx(handle, '')[0] != str(INSTALL):
                raise SystemExit('QA installation identity already exists; preserve it for inspection')
    except FileNotFoundError:
        pass
if OUTPUT.exists() and not resume:
    raise SystemExit('Preserve existing QA installer evidence')
OUTPUT.mkdir(parents=True, exist_ok=resume)
template_root = ROOT / 'apps/geod-agent-desktop/src-tauri/target/release/nsis/x64'
template = (template_root / 'installer.nsi').read_text(encoding='utf-8')
# The generated app-only payload is preserved. Only the installation/registry
# identity and process name change, avoiding interaction with an active dev app.
assert 'codex-runtime' not in template
for name, value in [('PRODUCTNAME', PRODUCT), ('BUNDLEID', IDENTIFIER),
                    ('MAINBINARYNAME', 'geod-component-install-qa'), ('OUTFILE', str(OUTPUT / 'qa-setup.exe')),
                    ('DISPLAYLANGUAGESELECTOR', 'false')]:
    pattern = r'^!define ' + name + r' ".*"$'
    template, count = re.subn(pattern, lambda _: '!define ' + name + ' "' + value + '"', template, flags=re.M)
    assert count == 1
template, count = re.subn(r'^\s*File "\$\{MAINBINARYSRCPATH\}"$', '  File /oname=${MAINBINARYNAME}.exe "${MAINBINARYSRCPATH}"', template, flags=re.M)
assert count == 1
if not resume:
    file = template_root / 'component-qa.nsi'
    file.write_text(template, encoding='utf-8')
    makensis = Path(os.environ['LOCALAPPDATA']) / 'tauri/NSIS/makensis.exe'
    try:
        subprocess.run([str(makensis), '/V2', str(file)], cwd=template_root, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    finally:
        file.unlink()
else:
    assert (OUTPUT / 'qa-setup.exe').is_file()
INSTALL.mkdir(exist_ok=resume)
marker = INSTALL / 'codex-runtime/legacy-marker.txt'
marker.parent.mkdir(exist_ok=resume)
marker.write_bytes(b'An unchanged installed component must survive NSIS update mode.\n')
records = INSTALL / 'existing-local-records.txt'
records.write_bytes(b'Existing records must not be overwritten by the app installer.\n')
(INSTALL / 'geod-component-install-qa.exe').write_bytes(b'Old application placeholder; never executed.\n')
subprocess.run([str(OUTPUT / 'qa-setup.exe'), '/S', '/UPDATE', '/NS', '/D=' + str(INSTALL)], check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
assert sha(INSTALL / 'geod-component-install-qa.exe') == sha(ROOT / 'apps/geod-agent-desktop/src-tauri/target/release/geod-agent-desktop.exe')
assert marker.read_bytes().startswith(b'An unchanged installed component')
assert records.read_bytes().startswith(b'Existing records')
uninstaller = INSTALL / 'uninstall.exe'
assert uninstaller.is_file()
# Verify the computed recursive-uninstall destination before invoking it.
assert uninstaller.resolve().parent == INSTALL.resolve() and INSTALL.resolve().is_relative_to((ROOT / 'artifacts').resolve())
subprocess.run([str(uninstaller), '/S', '_?=' + str(INSTALL)], check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
for key in REGKEYS:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            # NSIS intentionally retains the last install location unless the
            # user also deletes app data. Remove only this exact QA marker.
            assert key == REGKEYS[0] and winreg.QueryInfoKey(handle)[:2] == (0, 1)
            assert winreg.QueryValueEx(handle, '')[0] == str(INSTALL)
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except FileNotFoundError:
        pass
report = {'passed': True, 'actualNsisInstallerExecuted': True, 'updateMode': '/UPDATE',
          'applicationPayloadInstalled': True, 'unchangedRuntimePreserved': True, 'existingRecordsPreserved': True,
          'isolatedQaIdentity': IDENTIFIER, 'qaRegistrationRemoved': True, 'productionAppLaunched': False,
          'productionProfileModified': False, 'published': False}
(OUTPUT / 'acceptance.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
