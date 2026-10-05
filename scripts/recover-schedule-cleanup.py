"""Finish the recorded cleanup of a stopped, failed schedule QA run.

Only the fixed QA identity and ownership IDs from a terminal run are eligible.
Historical schedules, runs and generations remain available as failure evidence.
The original application's profile and credentials are never opened here.
"""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import sqlite3
import time

import psutil
from schedule_qa_identity import read_run

REPO = Path(__file__).resolve().parents[1]
ARTIFACTS = (REPO / "artifacts/schedule-stability-native-20261005").resolve()
OWNER = "credit-history-native-fixture"
PROFILE = "dev.geod-agent.credit-history-qa"


def assert_recorded_processes_stopped(records, lookup):
    checked = []
    for pid, created in sorted({(item["pid"], item["created"]) for item in records}):
        try:
            found = lookup(pid)
            assert found.create_time() != created, "A recorded QA process is still running"
            status = "pid-reused"
        except psutil.NoSuchProcess:
            status = "exited"
        # AccessDenied for a recorded identity must never be treated as exit.
        checked.append({"pid": pid, "created": created, "status": status})
    return checked


def table_fingerprint(db, tables, exclude):
    rows = {}
    for table in tables:
        values = db.execute(f"SELECT * FROM {table}").fetchall()
        rows[table] = sorted((row for row in values if not exclude(table, row)), key=repr)
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def disable_owned_schedules(db, ownership):
    ids = set(ownership["scheduleIds"])
    excluded = lambda table, row: table == "ai_schedules" and row[0] in ids and row[1] == OWNER
    tables = ["ai_schedules", "ai_runs", "ai_events"]
    before = table_fingerprint(db, tables, excluded)
    with db:
        for schedule_id in ids:
            row = db.execute("SELECT body,conversation FROM ai_schedules WHERE id=? AND owner=?",
                             (schedule_id, OWNER)).fetchone()
            assert row and row[1] == ownership["conversationId"], "Recorded QA schedule ownership mismatch"
            body = json.loads(row[0])
            assert body["scheduleId"] == schedule_id and body["conversationId"] == row[1]
            body["enabled"] = False
            db.execute("UPDATE ai_schedules SET enabled=0,body=? WHERE id=? AND owner=?",
                       (json.dumps(body, ensure_ascii=False, separators=(",", ":")), schedule_id, OWNER))
        assert table_fingerprint(db, tables, excluded) == before, "Unowned schedule/history rows changed"
    return {"disabledScheduleIds": sorted(ids), "unownedAndHistoryRowsUnchanged": True,
            "unownedAndHistorySha256": before}


def remove_owned_channel(db, ownership, delete_credential):
    channel_id = ownership["channelId"]
    recorded = set(ownership["channelReferences"])
    actual = {row[0] for row in db.execute("SELECT reference FROM credential_versions WHERE owner=? AND channel=?",
                                          (OWNER, channel_id))}
    assert actual <= recorded, "An unrecorded credential version must not be deleted"
    for reference in recorded:
        binding = db.execute("SELECT owner,channel FROM credential_versions WHERE reference=?", (reference,)).fetchone()
        assert binding is None or binding == (OWNER, channel_id), "A recorded reference belongs to another channel"
    tables = ["channels", "credential_versions", "selections", "generations", "active_routes", "sponsored_catalog"]

    def excluded(table, row):
        if table in ["channels", "credential_versions"]:
            return row[0] == OWNER and row[1] == channel_id
        return table == "selections" and row[0] == OWNER and row[1] == "default" and row[2] == channel_id

    before = table_fingerprint(db, tables, excluded)
    # Match native ai_channel_remove: remove the vault entries before metadata.
    credentials = [delete_credential(reference) for reference in sorted(recorded)]
    with db:
        db.execute("DELETE FROM channels WHERE owner=? AND id=?", (OWNER, channel_id))
        db.execute("DELETE FROM credential_versions WHERE owner=? AND channel=?", (OWNER, channel_id))
        db.execute("DELETE FROM selections WHERE owner=? AND conversation='default' AND channel=?", (OWNER, channel_id))
        assert table_fingerprint(db, tables, excluded) == before, "Unowned channel/history rows changed"
    return {"channelId": channel_id, "credentialMetadataRemoved": True, "credentials": credentials,
            "unownedAndHistoryRowsUnchanged": True, "unownedAndHistorySha256": before}


def windows_credential_delete(folder, reference):
    # Read only existence, free the pointer immediately; do not inspect its blob.
    target = hashlib.sha256(str(folder).encode()).hexdigest() + f":{reference}.GeoD-AI-channels"
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    api.CredDeleteW.restype = wintypes.BOOL
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    api.CredReadW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    if not api.CredDeleteW(target, 1, 0):
        assert ctypes.get_last_error() == 1168, "Recorded QA credential could not be deleted"
    pointer = ctypes.c_void_p()
    present = bool(api.CredReadW(target, 1, 0, ctypes.byref(pointer)))
    if present:
        api.CredFree(pointer)
    assert not present, "Recorded QA credential still exists"
    assert ctypes.get_last_error() == 1168, "Credential absence was not proven"
    return {"reference": reference, "credentialExists": False, "credentialContentsRead": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    assert root.parent == ARTIFACTS and root.name.startswith("fixture-")
    result = json.loads((root / "result.json").read_text(encoding="utf-8"))
    cleanup = json.loads((root / "cleanup.json").read_text(encoding="utf-8"))
    assert isinstance(result["passed"], bool) and cleanup["passed"] is False and cleanup.get("finishedAt")
    ownership = json.loads((root / "ownership.json").read_text(encoding="utf-8"))
    assert ownership["profile"] == PROFILE and ownership["account"] == OWNER
    assert Path(ownership["exe"]).resolve() == root / "target/release/geod-agent-desktop.exe"
    binary_sha = hashlib.sha256(Path(ownership["exe"]).read_bytes()).hexdigest()
    if binary_sha != "4b5f8ca2b213090da27785d7fc17d01e67532742126273bb7c56b880c79bd885":
        assert read_run(root)["qaExecutableSha256"] == binary_sha
    assert ownership["channelId"] and ownership["channelReferences"] and ownership["scheduleIds"]
    profile = Path(os.environ["APPDATA"]) / PROFILE
    recorded = list(ownership["processes"])
    recorded += [item for sample in result["samples"] for item in sample["children"]]
    for stage in cleanup["stages"]:
        if stage["name"] == "terminate-owned-processes":
            recorded += [item for entry in stage.get("result", [])
                         for item in entry.get("result", {}).get("descendantsAtTermination", [])]
    stopped = assert_recorded_processes_stopped(recorded, psutil.Process)
    for proc in psutil.process_iter(["name", "exe", "create_time"]):
        try:
            if proc.info["name"] == "geod-agent-desktop.exe":
                assert PROFILE.encode() not in Path(proc.info["exe"]).read_bytes(), "QA identity is still running"
            # Unrelated privileged console hosts do not expose cwd. All recorded
            # QA console hosts were checked above by PID and creation time.
            if proc.info["name"] in ["node.exe", "codex.exe"]:
                assert not Path(proc.cwd()).resolve().is_relative_to(profile.resolve()), "QA child is still running"
        except psutil.NoSuchProcess:
            continue
    report = {"passed": False, "observedAt": time.time(), "previousTestPassed": False,
              "previousRuntimeChecksPassed": result["passed"],
              "previousCleanupPassed": False, "profile": PROFILE, "originalProfileOpened": False,
              "recordedProcesses": stopped, "unrecordedConsoleHostsInspected": False}
    destination = root / "recovery-cleanup.json"

    def save():
        temporary = destination.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2), encoding="utf-8")
        temporary.replace(destination)

    save()
    try:
        with sqlite3.connect(profile / "agent-ai-schedules.sqlite") as schedules:
            assert schedules.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            report["schedules"] = disable_owned_schedules(schedules, ownership)
        save()
        folder = profile / "ai-channels"
        with sqlite3.connect(folder / "channels.sqlite") as channels:
            assert channels.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            report["channel"] = remove_owned_channel(channels, ownership, lambda ref: windows_credential_delete(folder, ref))
        report["passed"] = True
        save()
    except Exception as error:
        report["failure"] = str(error)
        save()
        raise
    print(json.dumps({"passed": True, "root": str(root), "originalProfileOpened": False}))


if __name__ == "__main__":
    main()
