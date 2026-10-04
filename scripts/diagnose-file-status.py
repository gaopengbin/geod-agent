"""Read the underlying status of an existing build file name, without writes."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
import json
import sys

class UnicodeString(c.Structure):
    _fields_ = [('length', w.USHORT), ('maximum', w.USHORT), ('buffer', w.LPWSTR)]

class ObjectAttributes(c.Structure):
    _fields_ = [('length', w.ULONG), ('root', w.HANDLE), ('name', c.POINTER(UnicodeString)),
                ('attributes', w.ULONG), ('security', w.LPVOID), ('quality', w.LPVOID)]

class IoStatus(c.Structure):
    _fields_ = [('status', c.c_void_p), ('information', c.c_size_t)]

path = Path(__file__).resolve().parents[1] / 'apps/geod-agent-desktop/src-tauri/resources/legacy-office/java/bin/ucrtbase.dll'
buffer = c.create_unicode_buffer('\\??\\' + str(path))
name = UnicodeString(len(buffer.value)*2, (len(buffer.value)+1)*2, c.cast(buffer, w.LPWSTR))
attributes = ObjectAttributes(c.sizeof(ObjectAttributes), None, c.pointer(name), 0x40, None, None)
handle, status = w.HANDLE(), IoStatus()
api = c.WinDLL('ntdll')
api.NtOpenFile.restype = c.c_long
if '--restore' in sys.argv:
    backup = path.with_suffix('.dll.source-previous')
    assert backup.is_file() and not path.exists()
    api.NtCreateFile.restype = c.c_long
    result = api.NtCreateFile(c.byref(handle), 0x40100000, c.byref(attributes), c.byref(status), None, 0x80, 7, 2, 0x60, None, 0)
    if result >= 0:
        c.WinDLL('kernel32').CloseHandle(handle)
        handle = w.HANDLE()
        path.write_bytes(backup.read_bytes())
else:
    result = api.NtOpenFile(c.byref(handle), 0x80000000, c.byref(attributes), c.byref(status), 7, 0x40)
if result >= 0:
    c.WinDLL('kernel32').CloseHandle(handle)
print(json.dumps({'nativeStatus': hex(result & 0xffffffff), 'fileExists': path.exists()}))
