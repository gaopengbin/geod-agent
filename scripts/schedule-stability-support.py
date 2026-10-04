"""Read-only observations and scoped process control for the native schedule QA.

RPC uses only the explicit QA profile. Termination checks PID, creation time,
canonical executable path and the unique artifact directory before acting.
"""
from pathlib import Path
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import winreg

import psutil

REPO = Path(__file__).resolve().parents[1]
QA_PROFILE = Path(os.environ["APPDATA"]) / "dev.geod-agent.credit-history-qa"
ARTIFACTS = (REPO / "artifacts/schedule-stability-native-20261005").resolve()


def executable(value):
    file = Path(value["exe"]).resolve()
    assert file.is_relative_to(ARTIFACTS) and file.name == "geod-agent-desktop.exe"
    assert file.parent.name == "release" and file.parent.parent.name == "target"
    assert b"dev.geod-agent.credit-history-qa" in file.read_bytes()
    return file


def process(value):
    expected = executable(value)
    found = psutil.Process(value["pid"])
    assert found.create_time() == value["created"]
    assert Path(found.exe()).resolve() == expected
    return found


def snapshot():
    rows = [{"pid": item.pid, "created": item.info["create_time"], "exe": item.info["exe"],
             "background": "--background-runtime" in (item.info["cmdline"] or [])}
            for item in psutil.process_iter(["name", "exe", "cmdline", "create_time"])
            if item.info["name"] == "geod-agent-desktop.exe"]
    startup = {}
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        for name in ["GeoD Agent", "GeoD Agent (development)"]:
            try:
                startup[name] = winreg.QueryValueEx(key, name)
            except FileNotFoundError:
                startup[name] = None
    return {"processes": rows, "startup": startup}


def sample(value):
    try:
        found = process(value)
    except psutil.NoSuchProcess:
        return {"pid": value["pid"], "alive": False}
    memory = found.memory_info()
    children = []
    for child in found.children(recursive=True):
        try:
            children.append({"pid": child.pid, "created": child.create_time(),
                             "name": child.name(), "rssBytes": child.memory_info().rss})
        except psutil.NoSuchProcess:
            pass
    windows = subprocess.run([sys.executable, "-X", "utf8", str(REPO / "scripts/native-process-evidence.py"),
                              "--pid", str(found.pid)], capture_output=True, encoding="utf-8", check=True)
    visibility = json.loads(windows.stdout)
    return {"pid": found.pid, "created": found.create_time(), "alive": found.is_running(),
            "rssBytes": memory.rss, "privateBytes": memory.private,
            "handles": found.num_handles(), "threads": found.num_threads(),
            "children": children, "visibleWindows": visibility["visibleWindows"],
            "webviewChildren": sum("msedgewebview" in child["name"].lower() for child in children)}


def terminate(value):
    try:
        found = process(value)
    except psutil.NoSuchProcess:
        return {"alreadyExited": True}
    children = [{"pid": child.pid, "created": child.create_time()} for child in found.children(recursive=True)]
    found.terminate()
    found.wait(timeout=15)
    return {"ownedProcessExited": True, "descendantsAtTermination": children}


def rpc(value):
    # Import the existing authenticated transport without executing its CLI.
    spec = importlib.util.spec_from_file_location("qa_background_probe", REPO / "scripts/background-runtime-probe.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    probe.ROOT = QA_PROFILE
    endpoint = json.loads((QA_PROFILE / "background-endpoint.json").read_text())
    return probe.request(endpoint, value.get("command", "runtime_status"), value.get("args", {}))


def start_background(value):
    file = executable(value)
    assert value["identityOrigin"].startswith("http://127.0.0.1:")
    env = dict(os.environ)
    for name in ["GEOD_QA_DEEPSEEK_KEY", "DEEPSEEK_API_KEY", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                 "GEOD_AGENT_DEV_GATEWAY_ORIGIN", "TAURI_CONFIG"]:
        env.pop(name, None)
    env["GEOD_AGENT_IDENTITY_ORIGIN"] = value["identityOrigin"]
    env["GEOD_AGENT_GATEWAY_ORIGIN"] = value["identityOrigin"]
    started = subprocess.Popen([str(file), "--background-runtime"], cwd=file.parent, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               close_fds=True, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB)
    found = psutil.Process(started.pid)
    return {"pid": found.pid, "created": found.create_time(), "exe": str(file), "background": True}


def channel_credentials(value):
    # Metadata existence only: never return credential contents.
    folder = QA_PROFILE / "ai-channels"
    db = sqlite3.connect((folder / "channels.sqlite").as_uri() + "?mode=ro", uri=True)
    references = [row[0] for row in db.execute("SELECT reference FROM credential_versions WHERE owner=? AND channel=?",
                                              ("credit-history-native-fixture", value["channelId"]))]
    db.close()
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    api.CredFree.argtypes = [ctypes.c_void_p]
    prefix = hashlib.sha256(str(folder).encode()).hexdigest()
    found = []
    for reference in value.get("references", references):
        pointer = ctypes.c_void_p()
        exists = bool(api.CredReadW(f"{prefix}:{reference}.GeoD-AI-channels", 1, 0, ctypes.byref(pointer)))
        if exists:
            api.CredFree(pointer)
        found.append({"reference": reference, "credentialExists": exists})
    return {"references": references, "credentials": found}


def run_ledger(value):
    db = sqlite3.connect((QA_PROFILE / "agent-ai-schedules.sqlite").as_uri() + "?mode=ro", uri=True)
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    row = db.execute("SELECT body FROM ai_runs WHERE id=? AND owner=?",
                     (value["runId"], "credit-history-native-fixture")).fetchone()
    assert row, "Only inspect this fixture account's actual native run"
    events = db.execute("SELECT seq,body FROM ai_events WHERE run=? ORDER BY seq", (value["runId"],)).fetchall()
    db.close()
    return {"run": json.loads(row[0]), "events": [json.loads(row[1]) for row in events],
            "sequences": [row[0] for row in events], "integrityCheck": "ok"}


def dialogs(value):
    process(value)
    completed = subprocess.run([sys.executable, "-X", "utf8", str(REPO / "apps/geod-agent-desktop/test/credit-history-native-support.py"), "dialogs"],
                               input=json.dumps(value), capture_output=True, encoding="utf-8", check=True)
    return json.loads(completed.stdout)


def select_folder(value):
    target = Path(value["path"]).resolve()
    assert target.is_relative_to(ARTIFACTS) and target.name == "workspace" and target.is_dir()
    found = [item for item in dialogs(value) if item["text"] == "选择或创建文件夹作为 GeoD Agent 工作区"]
    assert len(found) == 1, "Only operate the actual scoped workspace folder dialog"
    # Observed from this actual folder picker (file-save pickers use a different ID).
    edits = [item for item in found[0]["children"] if item["class"] == "Edit" and item["id"] == 1152 and item["visible"]]
    buttons = [item for item in found[0]["children"] if item["class"] == "Button" and item["id"] == 1 and item["visible"]]
    assert len(edits) == len(buttons) == 1, json.dumps(found)
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user.SendMessageW.restype = wintypes.LPARAM
    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    text = ctypes.create_unicode_buffer(str(target))
    assert user.SendMessageW(edits[0]["hwnd"], 0x000C, 0, ctypes.addressof(text))
    assert user.PostMessageW(buttons[0]["hwnd"], 0x00F5, 0, 0)
    return {"scopedFolderDialogOperated": True, "selectedDirectory": str(target), "pid": value["pid"]}


def usage_ledger(value):
    ids = value["generationIds"]
    assert 1 <= len(ids) <= 200 and len(set(ids)) == len(ids)
    assert all(isinstance(item, str) and 0 < len(item) <= 200 for item in ids)
    db = sqlite3.connect((QA_PROFILE / "ai-channels/channels.sqlite").as_uri() + "?mode=ro", uri=True)
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    rows = db.execute("SELECT id,body FROM generations WHERE owner=? AND id IN (" + ",".join("?" for _ in ids) + ") ORDER BY id",
                      ["credit-history-native-fixture", *ids]).fetchall()
    db.close()
    assert len(rows) == len(ids)
    bodies = [json.loads(body) for _, body in rows]
    assert all(body["state"] == "settled" and body["billingScope"] == "personal" and body["usageKnown"] for body in bodies)
    return {"passed": True, "settledGenerationRows": len(rows), "integrityCheck": "ok",
            "inputTokens": sum(body["inputTokens"] for body in bodies),
            "outputTokens": sum(body["outputTokens"] for body in bodies),
            "recordsSha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()}


def child_process_audit(value):
    known = {item["pid"]: item["created"] for item in value["observedChildren"]}
    remaining = []
    for found in psutil.process_iter(["name", "create_time"]):
        try:
            observed = known.get(found.pid) == found.info["create_time"]
            scoped = False
            if found.info["name"] in ["node.exe", "codex.exe", "conhost.exe", "geod-agent-desktop.exe"]:
                scoped = Path(found.cwd()).resolve().is_relative_to(QA_PROFILE.resolve())
            if observed or scoped:
                remaining.append({"pid": found.pid, "name": found.info["name"], "created": found.info["create_time"]})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return {"passed": not remaining, "observedChildIdentities": len(known), "remainingOwnedProcesses": remaining}


action = sys.argv[1]
value = json.loads(sys.stdin.read() or "{}")
operations = {"snapshot": lambda _: snapshot(), "sample": sample, "terminate": terminate,
              "rpc": rpc, "start-background": start_background, "channel-credentials": channel_credentials,
              "run-ledger": run_ledger, "dialogs": dialogs, "select-folder": select_folder,
              "usage-ledger": usage_ledger, "child-process-audit": child_process_audit}
print(json.dumps(operations[action](value)))
