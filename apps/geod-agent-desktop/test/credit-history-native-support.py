"""Windows helpers for an isolated native acceptance window; never touch real login."""
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import sys
import winreg

import psutil


class Credential(ctypes.Structure):
    _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]


def fixture_credential(action, value):
    from urllib.parse import urlparse
    origin = value["identity_origin"]
    parsed = urlparse(origin)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
    account = "geod-oauth-" + hashlib.sha256(origin.encode()).hexdigest()
    target = account + ".dev.geod-agent.desktop"
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                             ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    found = ctypes.POINTER(Credential)()
    exists = bool(api.CredReadW(target, 1, 0, ctypes.byref(found)))
    if exists:
        api.CredFree(found)
    if action == "seed":
        assert not exists, "Fixture must not replace an existing credential"
        assert value["user_id"] == "credit-history-native-fixture"
        blob = json.dumps(value, separators=(",", ":")).encode("utf-16-le")
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        credential = Credential(Type=1, TargetName=target, UserName=account,
                                CredentialBlobSize=len(blob), CredentialBlob=buffer, Persist=2)
        if not api.CredWriteW(ctypes.byref(credential), 0):
            raise ctypes.WinError(ctypes.get_last_error())
    elif action == "delete":
        if exists and not api.CredDeleteW(target, 1, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        assert not api.CredReadW(target, 1, 0, ctypes.byref(found)), "Fixture credential must be removed"
    return {"fixtureCredential": action, "fixtureCredentialRemoved": action == "delete", "realCredentialAccessed": False}


def snapshot():
    processes = [{"pid": p.pid, "created": p.info["create_time"], "exe": p.info["exe"],
                  "background": "--background-runtime" in (p.info["cmdline"] or [])}
                 for p in psutil.process_iter(["name", "exe", "cmdline", "create_time"])
                 if p.info["name"] == "geod-agent-desktop.exe"]
    startup = {}
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                        r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        for name in ["GeoD Agent", "GeoD Agent (development)"]:
            try:
                startup[name] = winreg.QueryValueEx(key, name)
            except FileNotFoundError:
                startup[name] = None
    return {"processes": processes, "startup": startup}


def terminate(value):
    try:
        process = psutil.Process(value["pid"])
    except psutil.NoSuchProcess:
        return {"alreadyExited": True}
    assert process.create_time() == value["created"]
    assert Path(process.exe()).resolve() == Path(value["exe"]).resolve()
    assert "target\\release\\geod-agent-desktop.exe" in str(Path(process.exe())).lower()
    process.terminate()
    process.wait(timeout=15)
    return {"ownedProcessExited": True}


def dialogs(value):
    process = psutil.Process(value["pid"])
    assert Path(process.exe()).name == "geod-agent-desktop.exe"
    assert "target\\release\\geod-agent-desktop.exe" in process.exe().lower()
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetDlgCtrlID.argtypes = [wintypes.HWND]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback, wintypes.LPARAM]
    user.EnumChildWindows.argtypes = [wintypes.HWND, callback, wintypes.LPARAM]

    def description(window):
        text, kind = ctypes.create_unicode_buffer(512), ctypes.create_unicode_buffer(128)
        user.GetWindowTextW(window, text, 512)
        user.GetClassNameW(window, kind, 128)
        return {"hwnd": int(window), "text": text.value, "class": kind.value,
                "id": user.GetDlgCtrlID(window), "visible": bool(user.IsWindowVisible(window))}

    result = []

    @callback
    def top(window, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if pid.value == process.pid:
            item = description(window)
            if item["class"] == "#32770" and item["visible"]:
                children = []

                @callback
                def child(window, _):
                    children.append(description(window))
                    return True

                user.EnumChildWindows(window, child, 0)
                result.append({**item, "children": children})
        return True

    user.EnumWindows(top, 0)
    return result


def save_dialog(value):
    found = [d for d in dialogs(value) if d["text"] == "导出 AI 用量"]
    assert len(found) == 1, "Only operate the isolated export dialog"
    dialog = found[0]
    edits = [c for c in dialog["children"] if c["class"] == "Edit" and c["id"] == 1001 and c["visible"]]
    buttons = [c for c in dialog["children"] if c["class"] == "Button" and c["id"] == 1 and c["visible"]]
    assert len(edits) == len(buttons) == 1
    target = Path(value["path"]).resolve()
    root = Path(__file__).resolve().parents[3] / "artifacts" / "credit-history-native-20261004"
    assert target.is_relative_to(root.resolve()) and target.suffix == ".csv"
    assert target.parent.is_dir() and not target.exists(), "Avoid overwrite confirmation in UI acceptance"
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user.SendMessageW.restype = wintypes.LPARAM
    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    text = ctypes.create_unicode_buffer(str(target))
    assert user.SendMessageW(edits[0]["hwnd"], 0x000C, 0, ctypes.addressof(text))  # WM_SETTEXT
    assert user.PostMessageW(buttons[0]["hwnd"], 0x00F5, 0, 0)  # BM_CLICK, returns before native save
    return {"saveDialogOperated": True, "isolatedPid": value["pid"]}


action = sys.argv[1]
value = json.loads(sys.stdin.read() or "{}")
result = fixture_credential(action, value) if action in ["seed", "delete"] else (
    snapshot() if action == "snapshot" else dialogs(value) if action == "dialogs" else (
        save_dialog(value) if action == "save-dialog" else terminate(value)))
print(json.dumps(result))
