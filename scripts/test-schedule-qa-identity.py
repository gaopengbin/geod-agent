"""Reject stale or unowned QA artifacts before any native process is launched."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import schedule_qa_identity as identity


class QaBuildIdentityTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="geod-current-qa-boundary-")
        self.addCleanup(self.folder.cleanup)
        self.repo = Path(self.folder.name).resolve()
        self.patch = patch.object(identity, "ROOT", self.repo)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.source = self.repo / identity.AUTH_SOURCE
        self.source.parent.mkdir(parents=True)
        self.source.write_text("synthetic source only", encoding="utf-8")
        (self.source.parent.parent / "tauri.conf.json").write_text(json.dumps({"version": "0.2.2"}))
        self.build = self.repo / "artifacts/schedule-stability-native-20261005/fixture-boundary"
        (self.build / "target/release").mkdir(parents=True)
        self.binary = self.build / "target/release/geod-agent-desktop.exe"
        self.binary.write_bytes(identity.PROFILE.encode() + b" synthetic binary, never launched")
        (self.build / "tauri-qa.json").write_text(json.dumps({"identifier": identity.PROFILE}))
        self.receipt = {"passed": True, "identifier": identity.PROFILE, "changedProductInputs": [], "version": "0.2.2",
                        "qaExecutableSha256": identity.digest(self.binary),
                        "configSha256": identity.digest(self.build / "tauri-qa.json"),
                        "sourceSnapshotBeforeBuild": {identity.AUTH_SOURCE: identity.digest(self.source)}}
        self.write_receipt()

    def write_receipt(self):
        (self.build / "current-source-qa-build.json").write_text(json.dumps(self.receipt), encoding="utf-8")

    def test_recorded_source_accepted_but_changed_source_rejected(self):
        self.assertEqual(identity.read_build(self.build), self.receipt)
        self.source.write_text("later edit", encoding="utf-8")
        with self.assertRaisesRegex(AssertionError, "QA source changed"):
            identity.read_build(self.build)
        self.assertEqual(identity.read_build(self.build, check_current_source=False), self.receipt)

    def test_binary_replacement_and_failed_build_rejected(self):
        self.binary.write_bytes(identity.PROFILE.encode() + b" different binary")
        with self.assertRaises(AssertionError):
            identity.read_build(self.build)
        self.receipt["qaExecutableSha256"] = identity.digest(self.binary)
        self.receipt["passed"] = False
        self.write_receipt()
        with self.assertRaises(AssertionError):
            identity.read_build(self.build)

    def test_shipped_identity_and_wrong_version_rejected(self):
        self.receipt["identifier"] = "dev.geod-agent.desktop"
        self.write_receipt()
        with self.assertRaises(AssertionError):
            identity.read_build(self.build)
        self.receipt["identifier"] = identity.PROFILE
        self.receipt["version"] = "0.2.1"
        self.write_receipt()
        with self.assertRaises(AssertionError):
            identity.read_build(self.build)

    def test_unowned_build_reference_is_rejected_before_file_read(self):
        run = self.build.parent / "fixture-run"
        run.mkdir()
        (run / "payload.json").write_text(json.dumps({"currentSourceQaBuild": str(self.repo / "outside-artifacts"),
                                                     "currentSourceQaBuildSha256": "bad"}))
        with self.assertRaises(AssertionError):
            identity.read_run(run)
        self.receipt["sourceSnapshotBeforeBuild"]["apps/geod-agent-desktop/../../outside"] = "bad"
        self.write_receipt()
        with self.assertRaises(AssertionError):
            identity.read_build(self.build, check_current_source=False)


if __name__ == "__main__":
    unittest.main()
