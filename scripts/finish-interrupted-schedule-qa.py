"""Remove only an interrupted fixture's local credentials; retain all history."""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import importlib.util
import json
import os
import sqlite3

import psutil

REPO = Path(__file__).resolve().parents[1]
ARTIFACTS = (REPO / "artifacts/schedule-stability-native-20261005").resolve()
PROFILE = "dev.geod-agent.credit-history-qa"
ACCOUNT = "credit-history-native-fixture"


def rows_hash(database, query, parameters=()):
    rows = database.execute(query, parameters).fetchall()
    return {"rows": len(rows), "sha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()}


def backup(database, destination):
    assert not destination.exists()
    with sqlite3.connect(destination) as target:
        database.backup(target)
        assert target.execute("PRAGMA quick_check").fetchone()[0] == "ok"


parser = argparse.ArgumentParser()
parser.add_argument("--fixture", type=Path, required=True)
args = parser.parse_args()
root = args.fixture.resolve(strict=True)
assert root.is_relative_to(ARTIFACTS) and root.name.startswith("fixture-")
owner = json.loads((root / "ownership.json").read_text(encoding="utf-8"))
assert owner["profile"] == PROFILE and owner["account"] == ACCOUNT
assert owner["identityOrigin"] == "http://127.0.0.1:60331"
for value in owner["processes"]:
    try:
        process = psutil.Process(value["pid"])
        assert process.create_time() != value["created"] or process.exe().casefold() != value["exe"].casefold()
    except psutil.NoSuchProcess:
        pass
assert not any(p.info["name"] == "geod-agent-desktop.exe" and
               ("schedule-stability" in (p.info["exe"] or "").lower() or
                "credit-history" in (p.info["exe"] or "").lower())
               for p in psutil.process_iter(["name", "exe"]))

# This is the original packaged-host profile; no independent user profile is opened.
profile = Path(os.environ["LOCALAPPDATA"]) / "Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming" / PROFILE
assert profile.is_dir()
report_path = root / "interrupted-owned-state-cleanup-20261006.json"
assert not report_path.exists()
report = {"passed": False, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "profile": PROFILE, "account": ACCOUNT, "modelCalls": 0,
          "userProfileModified": False, "runHistoryDeleted": False,
          "providerCredentialValuesRead": False, "fullEndurancePassed": False}

spec = importlib.util.spec_from_file_location("owned_credential", REPO / "scripts/schedule-fixture-credential.py")
credential = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credential)
api = ctypes.WinDLL("advapi32", use_last_error=True)
api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                        ctypes.POINTER(ctypes.POINTER(credential.Credential))]
api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
api.CredFree.argtypes = [ctypes.c_void_p]
channels = sqlite3.connect(profile / "ai-channels/channels.sqlite")
schedules = sqlite3.connect(profile / "agent-ai-schedules.sqlite")
try:
    backup(channels, root / "interrupted-channels-before.sqlite")
    backup(schedules, root / "interrupted-schedules-before.sqlite")
    before = {table: rows_hash(channels, "SELECT * FROM " + table + " ORDER BY rowid")
              for table in ("generations", "active_routes", "sponsored_catalog")}
    before.update({table: rows_hash(schedules, "SELECT * FROM " + table + " ORDER BY rowid")
                   for table in ("ai_runs", "ai_events")})
    refs = [row[0] for row in channels.execute(
        "SELECT reference FROM credential_versions WHERE owner=? AND channel=?", (ACCOUNT, owner["channelId"]))]
    assert sorted(refs) == sorted(owner["channelReferences"])
    assert channels.execute("SELECT COUNT(*) FROM channels WHERE owner=? AND id=?", (ACCOUNT, owner["channelId"])).fetchone()[0] == 1
    nominal = Path(os.environ["APPDATA"]) / PROFILE / "ai-channels"
    prefix = hashlib.sha256(str(nominal).encode()).hexdigest()
    removed = []
    for reference in refs:
        target = prefix + ":" + reference + ".GeoD-AI-channels"
        pointer = ctypes.POINTER(credential.Credential)()
        exists = bool(api.CredReadW(target, 1, 0, ctypes.byref(pointer)))
        if exists:
            try:
                assert pointer.contents.UserName == prefix + ":" + reference
            finally:
                api.CredFree(pointer)
            if not api.CredDeleteW(target, 1, 0):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            assert ctypes.get_last_error() == 1168
        assert not api.CredReadW(target, 1, 0, ctypes.byref(pointer))
        assert ctypes.get_last_error() == 1168
        removed.append({"reference": reference, "systemCredentialAbsent": True})
    with channels:
        channels.execute("DELETE FROM channels WHERE owner=? AND id=?", (ACCOUNT, owner["channelId"]))
        channels.execute("DELETE FROM credential_versions WHERE owner=? AND channel=?", (ACCOUNT, owner["channelId"]))
        channels.execute("DELETE FROM selections WHERE owner=? AND conversation='default' AND channel=?", (ACCOUNT, owner["channelId"]))
    disabled = []
    with schedules:
        for schedule_id in owner["scheduleIds"]:
            row = schedules.execute("SELECT body FROM ai_schedules WHERE id=? AND owner=? AND conversation=?",
                                    (schedule_id, ACCOUNT, owner["conversationId"])).fetchone()
            assert row
            value = json.loads(row[0])
            assert value["scheduleId"] == schedule_id
            value["enabled"] = False
            schedules.execute("UPDATE ai_schedules SET enabled=0,body=? WHERE id=? AND owner=? AND conversation=?",
                              (json.dumps(value, separators=(",", ":")), schedule_id, ACCOUNT, owner["conversationId"]))
            disabled.append(schedule_id)
    after = {table: rows_hash(channels, "SELECT * FROM " + table + " ORDER BY rowid")
             for table in ("generations", "active_routes", "sponsored_catalog")}
    after.update({table: rows_hash(schedules, "SELECT * FROM " + table + " ORDER BY rowid")
                  for table in ("ai_runs", "ai_events")})
    assert after == before
    assert channels.execute("SELECT COUNT(*) FROM credential_versions WHERE owner=? AND channel=?", (ACCOUNT, owner["channelId"])).fetchone()[0] == 0
    report.update(passed=True, credentials=removed, disabledSchedules=disabled,
                  retainedHistory=after, syntheticIdentity=credential.fixture("delete", {"identity_origin": owner["identityOrigin"]}))
except BaseException as error:
    report["error"] = str(error)
    raise
finally:
    channels.close()
    schedules.close()
    report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
