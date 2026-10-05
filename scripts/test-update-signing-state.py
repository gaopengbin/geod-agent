"""Fault checks use a synthetic vault and DPAPI envelope, never the release key."""
import base64
from contextlib import ExitStack
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

import update_signing_vault as vault


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


signer = load("candidate_signer", "sign-update-candidate.py")
builder = load("candidate_builder", "build-release-candidate.py")


class SigningState(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="geod-signing-state-test-"))).resolve()
        self.stack.enter_context(patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}))
        packet = b"Ed" + bytes(range(40))
        public = b"untrusted comment: minisign public key: fixture\n" + base64.b64encode(packet) + b"\n"
        self.record = {"privateKey": base64.b64encode(b"synthetic private test value").decode(),
                       "publicKey": base64.b64encode(public).decode(), "createdAt": "2026-10-05T00:00:00+00:00"}
        self.saved = None
        self.generate = self.stack.enter_context(patch.object(vault, "generate", return_value=copy.deepcopy(self.record)))
        self.stack.enter_context(patch.object(vault, "read_secret", side_effect=lambda: copy.deepcopy(self.saved)))
        self.stack.enter_context(patch.object(vault, "write_secret", side_effect=self.save))
        self.stack.enter_context(patch.object(vault, "protect", side_effect=self.envelope))
        self.folder = self.root / "GeoD/release-signing/candidate-v1"
        self.backup = self.folder / "recovery.dpapi"
        self.public = self.folder / "public.json"

    def save(self, record):
        self.saved = copy.deepcopy(record)

    def envelope(self, data, decrypt=False):
        marker = b"SYNTHETIC-DPAPI:"
        if decrypt:
            if not data.startswith(marker):
                raise ValueError("Synthetic recovery blob is corrupt")
            return data[len(marker):]
        return marker + data

    def test_repeated_provision_preserves_key_and_backup(self):
        first = vault.candidate_key(True)
        blob = self.backup.read_bytes()
        self.assertEqual(vault.candidate_key(True), first)
        self.assertEqual(self.backup.read_bytes(), blob)
        self.generate.assert_called_once()
        self.assertEqual(list(self.folder.glob("*.pending")), [])

    def test_public_write_interruption_recovers_same_backup(self):
        original = vault.write_once

        def interrupted(file, data):
            if file.name == "public.json":
                raise OSError("Simulated interruption before public identity")
            original(file, data)

        with patch.object(vault, "write_once", side_effect=interrupted):
            with self.assertRaises(OSError):
                vault.candidate_key(True)
        self.assertIsNone(self.saved)
        blob = self.backup.read_bytes()
        self.assertFalse(self.public.exists())
        self.assertEqual(vault.candidate_key(True)[0], self.record)
        self.assertEqual(self.backup.read_bytes(), blob)
        self.generate.assert_called_once()

    def test_vault_write_interruption_recovers_same_identity(self):
        with patch.object(vault, "write_secret", side_effect=OSError("Simulated vault write failure")):
            with self.assertRaises(OSError):
                vault.candidate_key(True)
        blob = self.backup.read_bytes()
        public = self.public.read_bytes()
        self.assertEqual(vault.candidate_key(True)[0], self.record)
        self.assertEqual(self.backup.read_bytes(), blob)
        self.assertEqual(self.public.read_bytes(), public)
        self.generate.assert_called_once()

    def test_missing_vault_restores_without_generating(self):
        vault.candidate_key(True)
        self.saved = None
        blob = self.backup.read_bytes()
        self.assertEqual(vault.candidate_key(True)[0], self.record)
        self.assertEqual(self.backup.read_bytes(), blob)
        self.generate.assert_called_once()

    def test_public_only_without_vault_refuses_rotation(self):
        self.folder.mkdir(parents=True)
        original = json.dumps(vault.public_record(self.record)).encode()
        self.public.write_bytes(original)
        with self.assertRaises(ValueError):
            vault.candidate_key(True)
        self.generate.assert_not_called()
        self.assertEqual(self.public.read_bytes(), original)
        self.assertFalse(self.backup.exists())

    def test_corrupt_backup_without_vault_refuses_rotation(self):
        self.folder.mkdir(parents=True)
        self.backup.write_bytes(b"corrupt fixture")
        with self.assertRaises(ValueError):
            vault.candidate_key(True)
        self.generate.assert_not_called()
        self.assertEqual(self.backup.read_bytes(), b"corrupt fixture")

    def test_public_mismatch_preserves_all_existing_state(self):
        vault.candidate_key(True)
        invalid = json.loads(self.public.read_text())
        invalid["publicKeyFingerprint"] = "different fixture"
        self.public.write_text(json.dumps(invalid))
        before = (self.backup.read_bytes(), self.public.read_bytes(), copy.deepcopy(self.saved))
        with self.assertRaises(ValueError):
            vault.candidate_key(True)
        self.assertEqual((self.backup.read_bytes(), self.public.read_bytes(), self.saved), before)
        self.generate.assert_called_once()

    def test_existing_vault_recreates_missing_backup(self):
        vault.candidate_key(True)
        self.backup.unlink()
        self.assertEqual(vault.candidate_key(True)[0], self.record)
        self.assertTrue(self.backup.exists())
        self.generate.assert_called_once()

    def test_public_environment_omits_ambient_signing_secrets(self):
        environment = {"PATH": "fixture path", "GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json"}
        environment.update({name: "synthetic secret" for name in vault.SIGNING_VARIABLES})
        self.assertEqual(vault.public_environment(environment), {"PATH": "fixture path", "GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json"})
        with patch.dict(os.environ, environment):
            signed = vault.signing_environment(self.record)
        self.assertEqual(signed["TAURI_SIGNING_PRIVATE_KEY"], self.record["privateKey"])
        self.assertEqual(signed["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], "")
        self.assertNotIn("TAURI_SIGNING_PRIVATE_KEY_PATH", signed)

    def test_signed_bundler_has_static_public_updater_configuration(self):
        environment = {"GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json", "GEOD_UPDATE_PUBLIC_KEY": self.record["publicKey"], "TAURI_SIGNING_PRIVATE_KEY": self.record["privateKey"]}
        config = builder.bundle_config(environment, True, "lzma")
        self.assertFalse(config["bundle"]["createUpdaterArtifacts"], "Compilation must not sign with a private-key environment")
        self.assertEqual(config["plugins"]["updater"], {"pubkey": self.record["publicKey"], "endpoints": [environment["GEOD_UPDATE_ENDPOINT"]], "requireSignedVersion": True, "dangerousInsecureTransportProtocol": False})
        self.assertNotIn(self.record["privateKey"], json.dumps(config))
        self.assertNotIn("plugins", builder.bundle_config(environment, False, "lzma"))

    def test_invalid_versions_are_rejected_before_installer_access(self):
        for value in ["../../other", "0.2.2-01", "0.2.2-.", "0.2.2+", "01.2.3", "1\u0661.2.3", 2, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                signer.reviewed_installer(self.root, {"version": value})

    def test_semver_release_prerelease_and_metadata_supported(self):
        for value in ["0.2.2", "0.2.2-rc.1", "0.2.2-alpha+build.007"]:
            file = self.root / f"GeoD Agent_{value}_x64-setup.exe"
            file.write_bytes(b"fixture installer")
            self.assertEqual(signer.reviewed_installer(self.root, {"version": value}), (value, file))

    def test_signature_review_child_never_receives_private_key(self):
        original = self.root / "artifacts/release-candidate-test"
        original.mkdir(parents=True)
        installer = original / "GeoD Agent_0.2.2_x64-setup.exe"
        installer.write_bytes(b"fixture installer")
        digest = hashlib.sha256(installer.read_bytes()).hexdigest()
        (original / "candidate.json").write_text(json.dumps({"version": "0.2.2", "artifacts": {installer.name: {"sha256": digest, "bytes": installer.stat().st_size}}}))
        output = self.root / "artifacts/update-candidate-test"
        cli = self.root / "apps/geod-agent-desktop/node_modules/@tauri-apps/cli/package.json"
        cli.parent.mkdir(parents=True)
        cli.write_text('{"version":"2.12.0"}')
        child_environments = []

        def run(arguments, **kwargs):
            child_environments.append(kwargs["env"])
            output.joinpath("update-verification.json").write_text(json.dumps({"sha256": digest}))
            return Mock(returncode=0)

        args = ["sign", "--candidate", str(original), "--output", str(output), "--endpoint", "https://example.test/latest.json", "--artifact-base", "https://example.test/0.2.2"]
        with patch.object(signer, "ROOT", self.root), patch.object(signer, "candidate_key", return_value=(self.record, vault.public_record(self.record))), patch.object(signer, "sign"), patch.object(signer.subprocess, "run", side_effect=run), patch.object(sys, "argv", args), patch.dict(os.environ, {name: "synthetic ambient secret" for name in vault.SIGNING_VARIABLES}), patch("builtins.print"):
            signer.main()
        self.assertEqual(len(child_environments), 1)
        self.assertFalse(set(vault.SIGNING_VARIABLES).intersection(child_environments[0]))

    def test_build_packaging_and_review_children_receive_only_public_environment(self):
        desktop = self.root / "apps/geod-agent-desktop"
        installer = desktop / "src-tauri/target/release/bundle/nsis/GeoD Agent_0.2.2_x64-setup.exe"
        installer.parent.mkdir(parents=True)
        installer.write_bytes(b"fixture installer")
        Path(str(installer) + ".sig").write_text("fixture signature")
        target = self.root / "artifacts/release-candidate-test"
        children = []

        def run(arguments, **kwargs):
            children.append((arguments, kwargs["env"]))
            if any(str(value).endswith("package-release-candidate.py") for value in arguments):
                target.mkdir(parents=True)
            return Mock(returncode=0)

        environment = {"GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json", "GEOD_UPDATE_ARTIFACT_BASE": "https://example.test/0.2.2", "GEOD_UPDATE_PUBLIC_KEY": self.record["publicKey"], "TAURI_SIGNING_PRIVATE_KEY": self.record["privateKey"], "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "synthetic password", "TAURI_SIGNING_PRIVATE_KEY_PATH": "synthetic old key path"}
        args = ["build", "--output", str(target), "--signed-update"]
        signing = Mock()
        signing.candidate_key.return_value = (self.record, vault.public_record(self.record))
        with patch.object(builder, "ROOT", self.root), patch.object(builder, "DESKTOP", desktop), patch.object(builder, "source_config"), patch.object(builder, "release_environment", side_effect=dict), patch.object(builder, "write_stamp", return_value={}), patch.object(builder, "inventory", return_value={"version": "0.2.2", "runtimes": []}), patch.object(builder.subprocess, "run", side_effect=run), patch.object(builder, "sign_module", return_value=signing), patch.object(sys, "argv", args), patch.dict(os.environ, environment), patch("builtins.print"):
            builder.main()
        self.assertEqual(len(children), 3)
        for _, environment in children:
            self.assertFalse(set(vault.SIGNING_VARIABLES).intersection(environment))
        signing.sign.assert_called_once_with(target / installer.name, self.record, "0.2.2")

    def test_ci_key_is_held_by_parent_and_passed_only_to_detached_signer(self):
        desktop = self.root / "apps/geod-agent-desktop"
        desktop.mkdir(parents=True)
        target = self.root / "artifacts/release-candidate-ci"
        secret = base64.b64encode(b"untrusted comment: rsign encrypted secret key\n" + base64.b64encode(b"synthetic CI packet") + b"\n").decode()
        environment = {"GEOD_UPDATE_ENDPOINT": "https://example.test/latest.json", "GEOD_UPDATE_ARTIFACT_BASE": "https://example.test/0.2.2",
                       "GEOD_UPDATE_PUBLIC_KEY": self.record["publicKey"], "TAURI_SIGNING_PRIVATE_KEY": secret,
                       "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "synthetic CI password"}
        children = []
        def run(arguments, **kwargs):
            children.append(kwargs["env"])
            if any(str(value).endswith("package-release-candidate.py") for value in arguments):
                target.mkdir(parents=True)
            return Mock(returncode=0)
        signing = Mock()
        args = ["build", "--output", str(target), "--signed-update", "--signing-key-source", "environment"]
        with patch.object(builder, "ROOT", self.root), patch.object(builder, "DESKTOP", desktop), patch.object(builder, "source_config"), patch.object(builder, "release_environment", side_effect=dict), patch.object(builder, "write_stamp", return_value={}), patch.object(builder, "inventory", return_value={"version": "0.2.2"}), patch.object(builder.subprocess, "run", side_effect=run), patch.object(builder, "sign_module", return_value=signing), patch.object(sys, "argv", args), patch.dict(os.environ, environment), patch("builtins.print"):
            builder.main()
        self.assertEqual(len(children), 3)
        self.assertTrue(all(not set(vault.SIGNING_VARIABLES).intersection(child) for child in children))
        signing.candidate_key.assert_not_called()
        record = signing.sign.call_args.args[1]
        self.assertEqual(record["privateKey"], secret)
        self.assertEqual(vault.signing_environment(record)["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], "synthetic CI password")

    def test_missing_or_file_based_ci_key_is_rejected_without_echoing_secret(self):
        for value in ["", "C:\\private\\candidate.key", base64.b64encode(b"wrong document").decode()]:
            with self.subTest(valueLength=len(value)):
                with self.assertRaisesRegex(ValueError, "inline encoded Tauri key") as cause:
                    builder.environment_signing_key({"TAURI_SIGNING_PRIVATE_KEY": value})
                if value:
                    self.assertNotIn(value, str(cause.exception))


if __name__ == "__main__":
    unittest.main()
