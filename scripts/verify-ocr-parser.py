"""Actual pinned CPU OCR with network denied and Windows-only PATH."""
from pathlib import Path
import json
import os
import subprocess
import time

repo = Path(__file__).resolve().parents[1]
root = repo / 'artifacts/product-gaps-20261004/document-ocr'
fixtures = json.loads((root / 'fixtures.json').read_text(encoding='utf-8'))
resources = repo / 'apps/geod-agent-desktop/src-tauri/resources'
worker = repo / 'apps/geod-agent-desktop/src-tauri/src/attachment_worker.py'
python = resources / 'gdal/python.exe'
runner = "import sys,socket,runpy;sys.dont_write_bytecode=True;deny=lambda *a,**k:(_ for _ in ()).throw(RuntimeError('Network disabled for offline OCR acceptance'));socket.socket.connect=deny;socket.create_connection=deny;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')"
environment = {key: value for key, value in os.environ.items()
               if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'}}
environment['PATH'] = str(Path(os.environ['SYSTEMROOT']) / 'System32')
report = {'passed': False, 'networkDenied': True, 'systemOnlyPath': True, 'cases': []}
cases = [
    ('scan-en.pdf', ['en'], [1]), ('scan-zh.pdf', ['zh'], [1]),
    ('mixed-pages.pdf', ['native', 'en', 'zh'], [2, 3]),
    ('scan-en.png', ['en'], [1]), ('scan-zh.png', ['zh'], [1]),
    ('scan-en.jpg', ['en'], [1]), ('scan-en.webp', ['en'], [1]),
    ('scan-en.bmp', ['en'], [1]), ('scan-multipage.tiff', ['en', 'zh'], [1, 2]),
    ('blank.pdf', [], None),
    ('encrypted-scan.pdf', 'ATTACHMENT_PASSWORD_REQUIRED', None),
    ('damaged.pdf', 'ATTACHMENT_DOCUMENT_INVALID', None),
    ('damaged.png', 'ATTACHMENT_DOCUMENT_INVALID', None),
]
try:
    for name, expected, pages in cases:
        started = time.monotonic()
        completed = subprocess.run([str(python), '-I', '-X', 'utf8', '-c', runner, str(worker),
                                    fixtures['files'][name]['path'], Path(name).suffix[1:],
                                    str(resources / 'documents'), str(resources / 'ocr')],
                                   env=environment, capture_output=True, encoding='utf-8',
                                   timeout=180, creationflags=subprocess.CREATE_NO_WINDOW)
        (root / (name+'.stdout.json')).write_text(completed.stdout, encoding='utf-8')
        (root / (name+'.stderr.txt')).write_text(completed.stderr, encoding='utf-8')
        value = json.loads(completed.stdout)
        if isinstance(expected, str):
            assert completed.returncode != 0 and value['error'] == expected, (name, value)
        else:
            assert completed.returncode == 0 and value['ok'], (name, value)
            for marker in expected: assert fixtures['markers'][marker] in value['text'], (name, marker, value)
            assert value.get('ocrPages') == pages, (name, value)
            if 'zh' in expected: assert '北京市' in value['text'], (name, value)
            if 'en' in expected: assert 'Beijing' in value['text'] and '12' in value['text'], (name, value)
            if 'native' in expected:
                assert 'Native PDF text must remain unchanged.' in value['text']
                assert value['text'].index(fixtures['markers']['native']) < value['text'].index(fixtures['markers']['en']) < value['text'].index(fixtures['markers']['zh'])
            if name == 'blank.pdf': assert not value['text'] and value['warnings'] == ['SCANNED_OR_EMPTY_PDF']
        case = {'name': name, 'passed': True, 'seconds': round(time.monotonic()-started, 3), 'actual': value}
        report['cases'].append(case)
        (root / 'parser-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: case[key] for key in ['name', 'passed', 'seconds']}), flush=True)
    report['passed'] = True
except Exception as error:
    report['error'] = str(error)
    failures = root / 'parser-failures.json'
    previous = json.loads(failures.read_text(encoding='utf-8')) if failures.is_file() else []
    previous.append({'error': report['error'], 'completed': len(report['cases'])})
    failures.write_text(json.dumps(previous, ensure_ascii=False, indent=2), encoding='utf-8')
    raise
finally:
    (root / 'parser-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
