"""Reject stale or isolated QA binaries before creating a candidate archive."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from release_build_identity import release_environment, source_config, verify_stamp, write_stamp


class OrdinaryBuild(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="geod-build-identity-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.native = self.root / "native"
        self.release = self.native / "target/release"
        self.installers = self.release / "bundle/nsis"
        self.installers.mkdir(parents=True)
        self.config = self.native / "tauri.conf.json"
        self.config.write_text(json.dumps({"identifier": "dev.geod-agent.desktop",
            "productName": "GeoD Agent", "version": "0.2.2", "app": {"windows": [{"label": "main"}]}}))
        self.executable = self.release / "geod-agent-desktop.exe"
        self.installer = self.installers / "GeoD Agent_0.2.2_x64-setup.exe"
        self.executable.write_bytes(b"ordinary binary fixture")
        self.installer.write_bytes(b"ordinary installer fixture")

    def test_same_executable_and_installer_match_the_build(self):
        record = write_stamp(self.native, self.release)
        self.assertEqual(record, verify_stamp(self.native, self.release))

    def test_rebuilt_qa_executable_cannot_reuse_an_old_installer(self):
        write_stamp(self.native, self.release)
        self.executable.write_bytes(b"isolated QA replacement")
        with self.assertRaises(ValueError):
            verify_stamp(self.native, self.release)

    def test_changed_installer_is_rejected(self):
        write_stamp(self.native, self.release)
        self.installer.write_bytes(b"stale installer")
        with self.assertRaises(ValueError):
            verify_stamp(self.native, self.release)

    def test_changed_source_config_and_versions_require_a_new_build(self):
        write_stamp(self.native, self.release)
        self.config.write_text(self.config.read_text().replace('"main"', '"changed"'))
        with self.assertRaises(ValueError):
            verify_stamp(self.native, self.release)

    def test_missing_receipt_is_rejected(self):
        with self.assertRaises(ValueError):
            verify_stamp(self.native, self.release)

    def test_isolated_identifier_and_remote_frontend_are_rejected(self):
        for config in [
            {"identifier": "dev.geod-agent.credit-history-qa", "productName": "GeoD Agent", "app": {"windows": []}},
            {"identifier": "dev.geod-agent.desktop", "productName": "GeoD Agent", "app": {"windows": [{"url": "http://127.0.0.1:1420/"}]}},
        ]:
            with self.subTest(config=config):
                self.config.write_text(json.dumps(config))
                with self.assertRaises(ValueError):
                    source_config(self.native)

    def test_development_identity_cannot_become_a_compile_time_default(self):
        cleaned = release_environment({"PATH": "keep", "GEOD_AGENT_IDENTITY_ORIGIN": "http://127.0.0.1:41000",
            "GEOD_AGENT_GATEWAY_ORIGIN": "http://127.0.0.1:41001", "GEOD_AGENT_DEV_GATEWAY_ORIGIN": "http://127.0.0.1:41002",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": "--remote-debugging-port=9235", "TAURI_CONFIG": "isolated", "GEOD_UPDATE_PUBLIC_KEY": "keep"})
        self.assertEqual(cleaned, {"PATH": "keep", "GEOD_UPDATE_PUBLIC_KEY": "keep"})


if __name__ == "__main__":
    unittest.main()
