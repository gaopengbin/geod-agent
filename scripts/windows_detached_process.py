"""Launch hidden development helpers outside the caller's Windows job.

Window hiding and a new process group do not detach Windows job ownership.
Fail closed if the requested helper is still tied to the caller's lifetime.
"""
import ctypes
from ctypes import wintypes
import os
import subprocess
import time


def process_in_job(pid):
    if os.name != "nt":
        raise RuntimeError("Windows process ownership verification is required")
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = api.OpenProcess(0x0400, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        found = wintypes.BOOL()
        if not api.IsProcessInJob(handle, None, ctypes.byref(found)):
            raise ctypes.WinError(ctypes.get_last_error())
        return bool(found.value)
    finally:
        api.CloseHandle(handle)


def process_package_identity(pid):
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.GetPackageFullName.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR]
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = api.OpenProcess(0x0400, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD()
        result = api.GetPackageFullName(handle, ctypes.byref(size), None)
        if result == 15700:
            return None
        if result != 122:
            raise ctypes.WinError(result)
        buffer = ctypes.create_unicode_buffer(size.value)
        result = api.GetPackageFullName(handle, ctypes.byref(size), buffer)
        if result:
            raise ctypes.WinError(result)
        return buffer.value
    finally:
        api.CloseHandle(handle)


def spawn_hidden_detached(command, *, cwd=None, env=None, stdout=None, stderr=None, _bootstrap=False):
    """Return only after a new owned process is verified outside Windows jobs."""
    if os.name != "nt":
        raise RuntimeError("This launcher is only for Windows development helpers")
    if process_in_job(os.getpid()) and not _bootstrap:
        from windows_explorer_launch import spawn_from_explorer
        return spawn_from_explorer(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr)
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL if stdout is None else stdout,
        stderr=subprocess.DEVNULL if stderr is None else stderr,
        close_fds=True,
        creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
                       | subprocess.CREATE_BREAKAWAY_FROM_JOB),
    )
    try:
        time.sleep(0.25)
        if process_in_job(process.pid):
            raise RuntimeError("Helper remains inside a Windows job; independent launch refused")
        if process_package_identity(process.pid) is not None:
            raise RuntimeError("Helper still inherits a packaged host identity; independent launch refused")
    except BaseException:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        raise
    return process
