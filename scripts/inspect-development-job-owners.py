"""Read job ownership for the two live development Node processes.

Only duplicate job handles for querying. Never assign, terminate, or change a
job; never read process memory or credential contents. Private handle layout is
from winsiderss/phnt ntexapi.h; querying uses Windows Job/Handle APIs.
"""
from pathlib import Path
import ctypes
from ctypes import wintypes
import json
import os
import secrets
import time

import psutil

TARGETS = {26584: 1791268190.9599, 59040: 1791268457.5242915}
for pid, created in TARGETS.items():
    assert psutil.Process(pid).create_time() == created


class Entry(ctypes.Structure):
    _fields_ = [("object", ctypes.c_void_p), ("pid", ctypes.c_size_t), ("handle", ctypes.c_size_t),
                ("access", wintypes.DWORD), ("creator", wintypes.WORD), ("type", wintypes.WORD),
                ("attributes", wintypes.DWORD), ("reserved", wintypes.DWORD)]


api = ctypes.WinDLL("kernel32", use_last_error=True)
nt = ctypes.WinDLL("ntdll")
api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
api.CreateJobObjectW.restype = wintypes.HANDLE
api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
api.OpenProcess.restype = wintypes.HANDLE
api.GetCurrentProcess.restype = wintypes.HANDLE
api.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
                               ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
api.CloseHandle.argtypes = [wintypes.HANDLE]
api.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
nt.NtQuerySystemInformation.argtypes = [ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
nt.NtQuerySystemInformation.restype = wintypes.LONG
marker = api.CreateJobObjectW(None, None)
assert marker
current = api.GetCurrentProcess()
report = {"at": time.time(), "processesModified": False, "jobLimitsModified": False,
          "processMemoryRead": False, "targets": list(TARGETS), "jobs": [], "unavailableOwnerQueries": []}
try:
    size = 1024 * 1024
    while True:
        assert size <= 64 * 1024 * 1024
        buffer = ctypes.create_string_buffer(size)
        needed = wintypes.DWORD()
        status = nt.NtQuerySystemInformation(64, buffer, size, ctypes.byref(needed)) & 0xffffffff
        if status == 0:
            break
        assert status == 0xc0000004, hex(status)
        size = max(size * 2, needed.value + 65536)
    count = ctypes.c_size_t.from_buffer(buffer).value
    assert 16 + count * ctypes.sizeof(Entry) <= size
    entries = (Entry * count).from_buffer(buffer, 16)
    marker_row = next(row for row in entries if row.pid == os.getpid() and row.handle == marker)
    job_type = marker_row.type
    user = psutil.Process().username().casefold()
    grouped = {}
    for row in entries:
        if row.type == job_type and row.object != marker_row.object:
            grouped.setdefault(row.object, []).append(row)
    report["systemJobObjectsObserved"] = len(grouped)
    for rows in grouped.values():
        observed, holders = None, []
        for row in rows:
            try:
                owner = psutil.Process(row.pid)
                if owner.username().casefold() != user:
                    continue
                metadata = {"pid": owner.pid, "name": owner.name(), "created": owner.create_time()}
                holders.append(metadata)
                if observed is not None:
                    continue
                source = api.OpenProcess(0x0040, False, row.pid)
                if not source:
                    report["unavailableOwnerQueries"].append(metadata)
                    continue
                duplicate = wintypes.HANDLE()
                try:
                    if not api.DuplicateHandle(source, row.handle, current, ctypes.byref(duplicate), 0x0004, False, 0):
                        report["unavailableOwnerQueries"].append(metadata)
                        continue
                    try:
                        data = ctypes.create_string_buffer(262144)
                        returned = wintypes.DWORD()
                        if not api.QueryInformationJobObject(duplicate, 3, data, len(data), ctypes.byref(returned)):
                            report["unavailableOwnerQueries"].append(metadata)
                            continue
                        members_count = wintypes.DWORD.from_buffer(data, 4).value
                        members = list((ctypes.c_size_t * members_count).from_buffer(data, 8))
                        limits = ctypes.create_string_buffer(144)
                        limits_ok = api.QueryInformationJobObject(duplicate, 9, limits, len(limits), ctypes.byref(returned))
                        flags = wintypes.DWORD.from_buffer(limits, 16).value if limits_ok else None
                        observed = {"members": members, "limitFlags": flags,
                                    "killOnLastHandleClose": bool(flags & 0x2000) if flags is not None else None}
                    finally:
                        api.CloseHandle(duplicate)
                finally:
                    api.CloseHandle(source)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if observed and set(TARGETS).intersection(observed["members"]):
            observed["holders"] = holders
            observed["matchingTargets"] = sorted(set(TARGETS).intersection(observed["members"]))
            report["jobs"].append(observed)
    report["observedTargetMemberships"] = sorted({pid for job in report["jobs"] for pid in job["matchingTargets"]})
    root = Path(__file__).resolve().parents[1] / "artifacts/windows-independent-launch-20261006"
    output = root / ("node-job-owners-" + secrets.token_hex(8) + ".json")
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"receipt": str(output), **report}, indent=2))
finally:
    api.CloseHandle(marker)
