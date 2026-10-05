"""Scope checks for offline recovery when the QA WebView cannot reopen."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("recover-schedule-cleanup.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class CleanupScope(unittest.TestCase):
    def test_live_or_unobservable_recorded_process_must_prevent_cleanup(self):
        record = [{"pid": 42, "created": 10}]
        class Process:
            def create_time(self):
                return 10
        with self.assertRaises(AssertionError):
            recovery.assert_recorded_processes_stopped(record, lambda pid: Process())
        def denied(pid):
            raise recovery.psutil.AccessDenied(pid)
        with self.assertRaises(recovery.psutil.AccessDenied):
            recovery.assert_recorded_processes_stopped(record, denied)

    def test_exited_and_reused_pid_are_distinguished(self):
        class Reused:
            def create_time(self):
                return 20
        def lookup(pid):
            if pid == 42:
                raise recovery.psutil.NoSuchProcess(pid)
            return Reused()
        result = recovery.assert_recorded_processes_stopped(
            [{"pid": 42, "created": 10}, {"pid": 43, "created": 10}], lookup)
        self.assertEqual([item["status"] for item in result], ["exited", "pid-reused"])

    def test_disable_preserves_other_owner_and_history_and_is_idempotent(self):
        db = sqlite3.connect(":memory:")
        db.executescript("CREATE TABLE ai_schedules(id,owner,conversation,enabled,next_at,body); CREATE TABLE ai_runs(id,body); CREATE TABLE ai_events(run,seq,body);")
        for schedule, owner in [("owned", recovery.OWNER), ("other", "real-owner")]:
            db.execute("INSERT INTO ai_schedules VALUES(?,?,?,?,?,?)", (schedule, owner, "conversation", 1, 42,
                       json.dumps({"scheduleId": schedule, "conversationId": "conversation", "enabled": True})))
        db.execute("INSERT INTO ai_runs VALUES(?,?)", ("old-run", "preserve history"))
        ownership = {"scheduleIds": ["owned"], "conversationId": "conversation"}
        first = recovery.disable_owned_schedules(db, ownership)
        self.assertEqual(first, recovery.disable_owned_schedules(db, ownership))
        self.assertEqual(db.execute("SELECT enabled,next_at FROM ai_schedules WHERE id='other'").fetchone(), (1, 42))
        self.assertEqual(db.execute("SELECT next_at FROM ai_schedules WHERE id='owned'").fetchone()[0], 42)
        with self.assertRaises(AssertionError):
            recovery.disable_owned_schedules(db, {"scheduleIds": ["other"], "conversationId": "conversation"})

    def test_channel_removal_never_deletes_unrecorded_key(self):
        db = sqlite3.connect(":memory:")
        db.executescript("CREATE TABLE channels(owner,id,body); CREATE TABLE credential_versions(owner,channel,reference); CREATE TABLE selections(owner,conversation,channel,model); CREATE TABLE generations(owner,id,body); CREATE TABLE active_routes(owner,run,body); CREATE TABLE sponsored_catalog(owner,body);")
        db.execute("INSERT INTO credential_versions VALUES(?,?,?)", (recovery.OWNER, "owned", "new-unrecorded"))
        deleted = []
        with self.assertRaises(AssertionError):
            recovery.remove_owned_channel(db, {"channelId": "owned", "channelReferences": ["old"]}, deleted.append)
        self.assertEqual(deleted, [])
        db.execute("UPDATE credential_versions SET reference='old'")
        db.execute("INSERT INTO channels VALUES(?,?,?)", ("real-owner", "owned", "preserve other owner"))
        db.execute("INSERT INTO generations VALUES(?,?,?)", (recovery.OWNER, "previous", "preserve usage"))
        result = recovery.remove_owned_channel(db, {"channelId": "owned", "channelReferences": ["old"]}, deleted.append)
        self.assertTrue(result["unownedAndHistoryRowsUnchanged"])
        self.assertEqual(deleted, ["old"])
        self.assertEqual(db.execute("SELECT body FROM channels").fetchone()[0], "preserve other owner")
        self.assertEqual(db.execute("SELECT body FROM generations").fetchone()[0], "preserve usage")

    def test_recorded_reference_cannot_delete_another_channels_vault_entry(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE credential_versions(owner,channel,reference)")
        db.execute("INSERT INTO credential_versions VALUES(?,?,?)", ("another-owner", "another-channel", "other-key"))
        deleted = []
        with self.assertRaises(AssertionError):
            recovery.remove_owned_channel(db, {"channelId": "owned", "channelReferences": ["other-key"]}, deleted.append)
        self.assertEqual(deleted, [])


if __name__ == "__main__":
    unittest.main()
