"""Restore the exact startup value only if QA changed it to this candidate."""
from pathlib import Path
import argparse
import json
import winreg
ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
output = Path(parser.parse_args().output).resolve()
assert output.is_relative_to(ROOT / 'artifacts') and output.name.startswith('release-candidate-')
record = json.loads((output / 'startup-before-qa.json').read_text(encoding='utf-8'))
with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Run', 0, winreg.KEY_READ | winreg.KEY_WRITE) as key:
    try:
        current, current_type = winreg.QueryValueEx(key, 'GeoD Agent')
    except FileNotFoundError:
        current, current_type = None, None
    unchanged = (record['exists'] and current == record['value'] and current_type == record['type']) or (not record['exists'] and current is None)
    if not unchanged:
        if current is None or str(output).casefold() not in current.casefold():
            raise SystemExit('An unrelated startup edit was detected; preserve it for user review.')
        if record['exists']:
            winreg.SetValueEx(key, 'GeoD Agent', 0, record['type'], record['value'])
        else:
            winreg.DeleteValue(key, 'GeoD Agent')
print(json.dumps({'startupRestored': True}))
