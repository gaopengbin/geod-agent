"""Launch a hidden bootstrap with the existing desktop as its parent.

The desktop app policy lets the bootstrap launch children independently of an
MSIX host. Environment values go to CreateProcessW in memory, never receipts.
"""
from pathlib import Path
import ctypes
from ctypes import wintypes
import json
import msvcrt
import os
import secrets
import subprocess
import sys
import time

import psutil

LAUNCHES = Path(__file__).resolve().parents[1] / "artifacts/windows-independent-launch-20261006"


class Startup(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("reserved", wintypes.LPWSTR),
                ("desktop", wintypes.LPWSTR), ("title", wintypes.LPWSTR),
                ("x", wintypes.DWORD), ("y", wintypes.DWORD), ("width", wintypes.DWORD),
                ("height", wintypes.DWORD), ("xchars", wintypes.DWORD), ("ychars", wintypes.DWORD),
                ("fill", wintypes.DWORD), ("flags", wintypes.DWORD),
                ("show", wintypes.WORD), ("reserved_bytes", wintypes.WORD),
                ("reserved_data", ctypes.c_void_p), ("stdin", wintypes.HANDLE),
                ("stdout", wintypes.HANDLE), ("stderr", wintypes.HANDLE)]


class StartupEx(ctypes.Structure):
    _fields_ = [("startup", Startup), ("attributes", ctypes.c_void_p)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE),
                ("pid", wintypes.DWORD), ("tid", wintypes.DWORD)]


class IndependentProcess:
    def __init__(self, value):
        self.pid = value["pid"]
        self._created = value["created"]
        self._process = psutil.Process(self.pid)
        assert self._process.create_time() == self._created

    def poll(self):
        if self._process.is_running():
            return None
        return self.wait(timeout=0)

    def wait(self, timeout=None):
        return self._process.wait(timeout=timeout)

    def terminate(self):
        assert self._process.create_time() == self._created
        self._process.terminate()


def log_path(stream):
    if stream is None or stream == subprocess.DEVNULL:
        return None
    if not isinstance(getattr(stream, "name", None), (str, os.PathLike)):
        raise ValueError("Independent helper output requires an explicit file")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    buffer = ctypes.create_unicode_buffer(32768)
    count = api.GetFinalPathNameByHandleW(msvcrt.get_osfhandle(stream.fileno()), buffer, len(buffer), 0)
    if not count or count >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    return buffer.value


def spawn_from_explorer(command, *, cwd=None, env=None, stdout=None, stderr=None):
    environment = dict(os.environ if env is None else env)
    command = [str(value) for value in command]
    for name, value in environment.items():
        if value and len(value) >= 16 and any(word in name.upper() for word in ("KEY", "TOKEN", "SECRET")):
            assert not any(value in item for item in command), "Credential arguments are forbidden"
    user = ctypes.WinDLL("user32", use_last_error=True)
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    user.GetShellWindow.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
    api.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    api.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    api.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                  wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                  ctypes.POINTER(StartupEx), ctypes.POINTER(ProcessInfo)]
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    api.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    shell_pid = wintypes.DWORD()
    window = user.GetShellWindow()
    assert window, "An existing interactive desktop is required"
    assert user.GetWindowThreadProcessId(window, ctypes.byref(shell_pid))
    shell = psutil.Process(shell_pid.value)
    assert shell.name().lower() == "explorer.exe"
    assert shell.username().lower() == psutil.Process().username().lower(), "Never switch Windows users"
    parent = api.OpenProcess(0x0080, False, shell.pid)
    if not parent:
        raise ctypes.WinError(ctypes.get_last_error())
    launch = LAUNCHES / ("launch-" + secrets.token_hex(8))
    launch.mkdir(parents=True, exist_ok=False)
    config = launch / "request.json"
    config.write_text(json.dumps({"command": command, "cwd": str(Path(cwd or os.getcwd()).resolve()),
                                 "stdoutPath": log_path(stdout), "stderrPath": log_path(stderr)}, indent=2), encoding="utf-8")
    interpreter = Path(sys.executable)
    worker = Path(__file__).with_name("windows_detached_worker.py").resolve()
    attributes, initialized, info = None, False, ProcessInfo()
    try:
        size = ctypes.c_size_t()
        api.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        assert size.value > 0
        attributes = ctypes.create_string_buffer(size.value)
        if not api.InitializeProcThreadAttributeList(attributes, 2, 0, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        initialized = True
        parent_value = wintypes.HANDLE(parent)
        if not api.UpdateProcThreadAttribute(attributes, 0, 0x00020000, ctypes.byref(parent_value), ctypes.sizeof(parent_value), None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        # The installed SDK defines DesktopAppPolicy as attribute 18.
        desktop_policy = wintypes.DWORD(1)
        if not api.UpdateProcThreadAttribute(attributes, 0, 0x00020012, ctypes.byref(desktop_policy), ctypes.sizeof(desktop_policy), None, None):
            raise ctypes.WinError(ctypes.get_last_error())
        startup = StartupEx()
        startup.startup.cb = ctypes.sizeof(startup)
        startup.startup.flags = 1
        startup.startup.show = 0
        startup.attributes = ctypes.cast(attributes, ctypes.c_void_p)
        bootstrap = ("import sys; output=open(sys.argv[1],'a',encoding='utf-8'); "
                     "sys.stdout=output; sys.stderr=output; import runpy,os; script=sys.argv[2]; "
                     "sys.argv=[script,sys.argv[3]]; sys.path.insert(0,os.path.dirname(script)); "
                     "runpy.run_path(script,run_name='__main__')")
        arguments = ctypes.create_unicode_buffer(subprocess.list2cmdline([
            str(interpreter), "-X", "utf8", "-c", bootstrap, str(launch / "bootstrap-errors.log"), str(worker), str(config)]))
        block = ctypes.create_unicode_buffer("\0".join(name + "=" + value for name, value in sorted(environment.items(), key=lambda item: item[0].upper())) + "\0\0")
        flags = 0x00000010 | 0x00000200 | 0x00080000 | 0x00000400
        if not api.CreateProcessW(str(interpreter), arguments, None, None, False, flags, block,
                                  str(worker.parent), ctypes.byref(startup), ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        until = time.monotonic() + 20
        receipt = launch / "result.json"
        while not receipt.exists() and time.monotonic() < until:
            code = wintypes.DWORD()
            if api.GetExitCodeProcess(info.process, ctypes.byref(code)) and code.value != 259:
                break
            time.sleep(0.05)
        if not receipt.exists():
            raise RuntimeError("Independent bootstrap acknowledgement missing; inspect " + str(launch / "bootstrap-errors.log"))
        value = json.loads(receipt.read_text(encoding="utf-8"))
        if not value["passed"]:
            raise RuntimeError(value["error"])
        assert value["bootstrapPid"] == info.pid
        assert value["childOutsideWindowsJobs"] and value["childPackageIdentity"] is None
        return IndependentProcess(value["child"])
    except BaseException:
        if info.process:
            api.TerminateProcess(info.process, 1)
        raise
    finally:
        if initialized:
            api.DeleteProcThreadAttributeList(attributes)
        if info.thread:
            api.CloseHandle(info.thread)
        if info.process:
            api.CloseHandle(info.process)
        api.CloseHandle(parent)
