"""Synthetic key checks for log filtering and candidate scanning."""
import base64
import importlib.util
from pathlib import Path
import tempfile
import textwrap
import unittest
from unittest.mock import patch, Mock
import sys
import json

spec = importlib.util.spec_from_file_location("signed_build_launcher", Path(__file__).with_name("build-signed-update-candidate.py"))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class SignedBuildLauncher(unittest.TestCase):
    def setUp(self):
        self.packet = b"synthetic signing packet only for isolated tests" * 4
        self.packet_text = base64.b64encode(self.packet)
        self.document = b"untrusted comment: rsign encrypted secret key\n" + self.packet_text + b"\n"
        self.record = {"privateKey": base64.b64encode(self.document).decode()}
        self.values = launcher.private_values(self.record)

    def test_private_log_forms_are_withheld(self):
        for data in [self.record["privateKey"], self.document.decode(), self.packet_text.decode(), self.packet.decode()]:
            with self.subTest(dataLength=len(data)):
                result = launcher.redact("before " + data + " after", self.values)
                self.assertNotIn(data, result)
                self.assertIn("[signing value withheld]", result)

    def test_detached_signer_changes_are_build_input_changes(self):
        for name in ("scripts/sign-update-candidate.py", "scripts/sign_update_candidate_for_tests.py"):
            with self.subTest(script=name):
                self.assertTrue(launcher.build_input(name))
        self.assertFalse(launcher.build_input("scripts/test-signed-build-launcher.py"))

    def test_public_and_failure_details_survive_redaction(self):
        text = "Windows refused build-script-build.exe (os error 5); public channel https://example.test/latest.json"
        self.assertEqual(launcher.redact(text, self.values), text)

    def test_private_material_across_scan_block_boundary_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="geod-signing-scan-test-") as folder:
            file = Path(folder) / "candidate.bin"
            file.write_bytes(b"x" * (1024 * 1024 - 8) + self.record["privateKey"].encode() + b"tail")
            self.assertTrue(launcher.contains_private(file, self.values))

    def test_utf16_private_material_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="geod-signing-scan-test-") as folder:
            file = Path(folder) / "candidate.bin"
            file.write_bytes(self.record["privateKey"].encode("utf-16-le"))
            self.assertTrue(launcher.contains_private(file, self.values))

    def test_clean_binary_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="geod-signing-scan-test-") as folder:
            file = Path(folder) / "candidate.bin"
            file.write_bytes(b"review candidate contains a public key only" * 1024)
            self.assertFalse(launcher.contains_private(file, self.values))

    def test_wrapped_private_key_is_detected_and_fully_filtered(self):
        wrapped = "\n".join(textwrap.wrap(self.record["privateKey"], width=64)) + "\n"
        filtered = launcher.redact(wrapped, self.values)
        self.assertNotIn(self.record["privateKey"], "".join(filtered.split()))
        with tempfile.TemporaryDirectory(prefix="geod-signing-wrap-test-") as folder:
            file = Path(folder) / "build.log"
            file.write_text(wrapped)
            self.assertTrue(launcher.contains_private(file, self.values))
            with self.assertRaises(ValueError):
                launcher.verify_logs(Path(folder), self.values)
            file.write_text(filtered)
            self.assertFalse(launcher.contains_private(file, self.values))
            launcher.verify_logs(Path(folder), self.values)

    def test_arbitrary_whitespace_and_json_escaped_key_are_detected(self):
        forms = [" \t\r\n\v\f".join(self.record["privateKey"]), "\\n".join(textwrap.wrap(self.record["privateKey"], width=64))]
        with tempfile.TemporaryDirectory(prefix="geod-signing-wrap-test-") as folder:
            file = Path(folder) / "build.log"
            for text in forms:
                with self.subTest(formLength=len(text)):
                    file.write_text(text)
                    self.assertTrue(launcher.contains_private(file, self.values))
                    file.write_text(launcher.redact(text, self.values))
                    self.assertFalse(launcher.contains_private(file, self.values))

    def test_formatted_key_over_large_whitespace_gap_is_detected(self):
        key = self.record["privateKey"].encode()
        with tempfile.TemporaryDirectory(prefix="geod-signing-wrap-test-") as folder:
            file = Path(folder) / "build.log"
            file.write_bytes(key[:64] + b" " * (2 * 1024 * 1024) + key[64:])
            self.assertTrue(launcher.contains_private(file, self.values))

    def test_mixed_case_unicode_escapes_and_scan_boundaries(self):
        with tempfile.TemporaryDirectory(prefix="geod-signing-wrap-test-") as folder:
            file = Path(folder) / "build.log"
            for separator in ["\\u000A", "\\u000D", "\\U000a", "\\U000d"]:
                text = separator.join(self.record["privateKey"])
                for encoding in ["utf-8", "utf-16-le"]:
                    with self.subTest(separator=separator, encoding=encoding):
                        file.write_bytes(b"x" * (1024 * 1024 - 7) + text.encode(encoding))
                        self.assertTrue(launcher.contains_private(file, self.values))
                        file.write_bytes(launcher.redact(text, self.values).encode(encoding))
                        self.assertFalse(launcher.contains_private(file, self.values))

    def test_candidate_structure_failure_persists_failed_receipt(self):
        with tempfile.TemporaryDirectory(prefix="geod-signing-receipt-test-") as folder:
            root = Path(folder).resolve()
            artifacts = root / "artifacts"
            artifacts.mkdir()
            config = artifacts / "public.json"
            config.write_text(json.dumps({"GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json", "GEOD_UPDATE_PUBLIC_KEY": "synthetic public key", "GEOD_UPDATE_ARTIFACT_BASE": "https://example.test/0.2.2"}))
            logs = artifacts / "build-log"
            output = artifacts / "release-candidate-test"
            args = ["build", "--public-config", str(config), "--output", str(output), "--logs", str(logs)]
            child = Mock(pid=42)
            child.stdout.read.return_value = "synthetic successful build\n"
            child.wait.return_value = 0
            public = {"publicKey": "synthetic public key", "publicKeyFingerprint": "synthetic fingerprint"}
            environments = []
            def start(arguments, **kwargs):
                environments.append(dict(kwargs["env"]))
                return child
            with patch.object(launcher, "ROOT", root), patch.object(launcher, "source_snapshot", return_value={}), patch.object(launcher, "source_config", return_value={"identifier": "dev.geod-agent.desktop", "version": "0.2.2"}), patch.object(launcher, "inventory", return_value={}), patch.object(launcher, "candidate_key", return_value=(self.record, public)), patch.object(launcher, "frozen_assets", return_value={}), patch.object(launcher.subprocess, "Popen", side_effect=start), patch.object(launcher, "verify_built_candidate", side_effect=KeyError("missingCandidateField")), patch.object(sys, "argv", args), patch("builtins.print"):
                with self.assertRaises(ValueError):
                    launcher.main()
            receipt = json.loads((logs / "result.json").read_text())
            self.assertEqual(receipt["phase"], "failed")
            self.assertFalse(receipt["passed"])
            self.assertIn("missingCandidateField", receipt["failure"])
            self.assertEqual(environments[0]["GEOD_UPDATE_PUBLIC_KEY"], public["publicKey"])
            self.assertFalse(any(name.startswith("TAURI_SIGNING_PRIVATE_KEY") for name in environments[0]))


if __name__ == "__main__":
    unittest.main()
