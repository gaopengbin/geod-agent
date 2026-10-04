"""Real CPU speech inference on self-authored Windows speech fixtures."""
from pathlib import Path
import json
import os
import subprocess
import time

root = Path(__file__).resolve().parents[1]
output = root / 'artifacts/product-gaps-20261004/audio-inputs'
engine = root / 'apps/geod-agent-desktop/src-tauri/resources/audio/whisper-cli.exe'
model = root / 'artifacts/runtime-cache/audio/ggml-base.bin'
environment = {key: value for key, value in os.environ.items() if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'}}
environment['PATH'] = str(Path(os.environ['SYSTEMROOT']) / 'System32')
results = []
for language, filename in [('en', 'beijing-english.wav'), ('zh', 'beijing-chinese.wav')]:
    source = output / 'workspace' / filename
    if not source.exists():
        continue
    started = time.monotonic()
    process = subprocess.run([str(engine), '-m', str(model), '-f', str(source), '-l', language,
                              '-ng', '-t', '4', '-np', '-nt', '-otxt', '-of', str(output / ('actual-' + language))],
                             cwd=engine.parent, env=environment, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    text = (output / ('actual-' + language + '.txt')).read_text(encoding='utf-8').strip() if process.returncode == 0 else ''
    passed = ('Beijing' in text and ('twelve' in text or '12' in text)) if language == 'en' else ('北京' in text and ('十二' in text or '12' in text))
    results.append({'language': language, 'passed': passed, 'exitCode': process.returncode,
                    'seconds': round(time.monotonic() - started, 2), 'text': text})
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
record = {'passed': bool(results) and all(item['passed'] for item in results), 'cases': results,
          'stockWindowsPath': True, 'audioUploadedToServer': False, 'engine': 'whisper.cpp 1.9.4 / b5130', 'model': 'base'}
(output / 'actual-engine.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
if not record['passed']:
    raise SystemExit('Actual audio inference did not recover the authored locations and zoom level')
