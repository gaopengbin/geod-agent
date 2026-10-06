"""Exercise host job closure using only short lived, owned probe processes."""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import datetime
import json
import os
import secrets
import subprocess
import sys
import time

import psutil
from windows_detached_process import process_in_job, spawn_hidden_detached

REPO = Path(__file__).resolve().parents[1]
ARTIFACTS = REPO / "artifacts" / "windows-independent-launch-20261006"


def write(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def identity(pid):
    process = psutil.Process(pid)
    return {"pid": pid, "created": process.create_time(), "exe": process.exe()}


def alive(value):
    try:
        process = psutil.Process(value["pid"])
        return process.create_time() == value["created"] and process.exe() == value["exe"]
    except psutil.NoSuchProcess:
        return False


def wait(check, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise TimeoutError("Owned independent-launch probe timed out")


class Basic(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t),
                ("max_ws", ctypes.c_size_t), ("active", wintypes.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                ("schedule", wintypes.DWORD)]


class Io(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in
                ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]


class Extended(ctypes.Structure):
    _fields_ = [("basic", Basic), ("io", Io), ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t)]


def role(root, name):
    assert root.is_relative_to(ARTIFACTS.resolve()) and root.name.startswith("probe-")
    if name == "heartbeat":
        for tick in range(60):
            write(root / "heartbeat.json", {"pid": os.getpid(), "tick": tick,
                                          "outsideWindowsJobs": not process_in_job(os.getpid())})
            time.sleep(0.25)
        return
    wait(lambda: (root / "gate.json").exists())
    assert process_in_job(os.getpid()), "Parent must be attached to the owned host job"
    with (root / "child.log").open("wb") as output:
        child = spawn_hidden_detached([sys.executable, "-X", "utf8", str(Path(__file__).resolve()),
                                      "--role", "heartbeat", "--root", str(root)],
                                     cwd=REPO, stdout=output, stderr=output)
    write(root / "child.json", identity(child.pid))
    time.sleep(20)


def verify():
    root = ARTIFACTS / ("probe-" + secrets.token_hex(8))
    root.mkdir(parents=True, exist_ok=False)
    report = {"passed": False, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "providerCalls": 0, "userDataModified": False, "productionModified": False,
              "systemRebootPerformed": False, "probeDirectory": str(root)}
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    api.CreateJobObjectW.restype = wintypes.HANDLE
    api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    job, handle, parent, child = None, None, None, None
    try:
        with (root / "parent.log").open("wb") as output:
            process = spawn_hidden_detached([sys.executable, "-X", "utf8", str(Path(__file__).resolve()),
                                            "--role", "parent", "--root", str(root)],
                                           cwd=REPO, stdout=output, stderr=output)
        parent = identity(process.pid)
        report["parent"] = parent
        job = api.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.basic.flags = 0x2000 | 0x0800
        if not api.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        handle = api.OpenProcess(0x0100 | 0x0001, False, parent["pid"])
        if not handle or not api.AssignProcessToJobObject(job, handle):
            raise ctypes.WinError(ctypes.get_last_error())
        api.CloseHandle(handle)
        handle = None
        write(root / "gate.json", {"ownedHostJobReady": True})
        wait(lambda: (root / "child.json").exists() and (root / "heartbeat.json").exists())
        child = json.loads((root / "child.json").read_text(encoding="utf-8"))
        report["child"] = child
        assert process_in_job(parent["pid"])
        assert not process_in_job(child["pid"])
        before = json.loads((root / "heartbeat.json").read_text(encoding="utf-8"))
        api.CloseHandle(job)
        job = None
        wait(lambda: not alive(parent))
        time.sleep(1.5)
        after = json.loads((root / "heartbeat.json").read_text(encoding="utf-8"))
        assert alive(child) and after["tick"] > before["tick"]
        assert after["outsideWindowsJobs"]
        report.update(hostJobActuallyClosed=True, parentActuallyExited=True,
                      childRemainedAlive=True, heartbeatAdvanced=True, outsideWindowsJobs=True)
        report["passed"] = True
    except BaseException as error:
        report["error"] = str(error)
        raise
    finally:
        if handle:
            api.CloseHandle(handle)
        if job:
            api.CloseHandle(job)
        cleanup = []
        for value in (child, parent):
            if value and alive(value):
                owned = psutil.Process(value["pid"])
                owned.terminate()
                owned.wait(15)
            if value:
                cleanup.append({"pid": value["pid"], "exited": not alive(value)})
        report["cleanup"] = cleanup
        report["passed"] = report["passed"] and all(x["exited"] for x in cleanup)
        report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write(root / "result.json", report)
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("parent", "heartbeat"))
    parser.add_argument("--root", type=Path)
    options = parser.parse_args()
    if options.role:
        assert options.root
        role(options.root.resolve(), options.role)
    else:
        verify()
