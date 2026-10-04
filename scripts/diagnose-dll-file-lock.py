from pathlib import Path
import ctypes as c
from ctypes import wintypes as w
import json

class UniqueProcess(c.Structure):
    _fields_ = [('pid', w.DWORD), ('start', w.FILETIME)]

class ProcessInfo(c.Structure):
    _fields_ = [('process', UniqueProcess), ('name', w.WCHAR*256), ('service', w.WCHAR*64),
                ('appType', w.UINT), ('status', w.ULONG), ('session', w.DWORD), ('restartable', w.BOOL)]

root = Path(__file__).resolve().parents[1] / 'apps/geod-agent-desktop/src-tauri'
paths = [str(root / name) for name in ['resources/legacy-office/java/bin/ucrtbase.dll',
                                      'resources/legacy-office/java/bin/ucrtbase.dll.source-previous',
                                      'target/debug/legacy-office-runtime/java/bin/ucrtbase.dll',
                                      'target/debug/legacy-office-runtime/java/bin/ucrtbase.dll.build-previous']]
api = c.WinDLL('Rstrtmgr')
session = w.DWORD()
key = c.create_unicode_buffer(33)
assert api.RmStartSession(c.byref(session), 0, key) == 0
try:
    files = (w.LPCWSTR * len(paths))(*paths)
    assert api.RmRegisterResources(session, len(paths), files, 0, None, 0, None) == 0
    needed, count, reason = w.UINT(), w.UINT(), w.DWORD()
    code = api.RmGetList(session, c.byref(needed), c.byref(count), None, c.byref(reason))
    values = (ProcessInfo * max(needed.value, 1))()
    count.value = needed.value
    if code == 234:
        code = api.RmGetList(session, c.byref(needed), c.byref(count), values, c.byref(reason))
    print(json.dumps({'code': code, 'reason': reason.value, 'processes': [{'pid': value.process.pid, 'name': value.name, 'status': value.status} for value in values[:count.value]]}, ensure_ascii=False))
finally:
    api.RmEndSession(session)
