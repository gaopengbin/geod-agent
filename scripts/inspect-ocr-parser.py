"""Fixture-only exception trace from the actual isolated worker."""
from pathlib import Path
import os
import subprocess
repo = Path(__file__).resolve().parents[1]
resources = repo / 'apps/geod-agent-desktop/src-tauri/resources'
worker = repo / 'apps/geod-agent-desktop/src-tauri/src/attachment_worker.py'
root = repo / 'artifacts/product-gaps-20261004/document-ocr'
code = """import sys,runpy
def trace(frame,event,value):
    if event=='exception' and frame.f_code.co_filename.endswith('attachment_worker.py'):
        print(frame.f_code.co_name,frame.f_lineno,value[0].__name__,str(value[1]),file=sys.stderr)
    return trace
sys.settrace(trace)
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
"""
environment = {key: value for key, value in os.environ.items()
               if key.upper() in {'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'}}
environment['PATH'] = str(Path(os.environ['SYSTEMROOT']) / 'System32')
completed = subprocess.run([str(resources/'gdal/python.exe'), '-I', '-X', 'utf8', '-c', code,
                            str(worker), str(root/'workspace/scan-en.pdf'), 'pdf',
                            str(resources/'documents'), str(resources/'ocr')],
                           env=environment, capture_output=True, encoding='utf-8', timeout=180,
                           creationflags=subprocess.CREATE_NO_WINDOW)
(root/'initial-parser-debug.txt').write_text(completed.stdout+'\n'+completed.stderr,encoding='utf-8')
print(completed.stdout+completed.stderr)
