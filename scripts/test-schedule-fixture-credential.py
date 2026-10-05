"""Exercise fixture persistence, ownership, and refusal to replace credentials."""
import hashlib
import importlib.util
from pathlib import Path
import secrets
import socket
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fixture_credential", Path(__file__).with_name("schedule-fixture-credential.py"))
credential = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credential)


class FixtureBoundaryTests(unittest.TestCase):
    def test_unsafe_origin_and_real_account_never_open_windows_vault(self):
        for value in [{"identity_origin": "https://geod.laogao.xyz"},
                      {"identity_origin": "http://127.0.0.1:5000", "user_id": "real-account"},
                      {"identity_origin": "http://user@127.0.0.1:5000"},
                      {"identity_origin": "http://127.0.0.1:5000?other=1"}]:
            with self.subTest(value=value), patch.object(credential.ctypes, "WinDLL") as vault:
                with self.assertRaises((AssertionError, ValueError)):
                    credential.fixture("seed", value)
                vault.assert_not_called()

    def test_actual_windows_fixture_has_native_persistence_and_cannot_be_replaced(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            origin = "http://127.0.0.1:" + str(listener.getsockname()[1])
            value = {"identity_origin": origin, "user_id": "credit-history-native-fixture",
                     "access_expires_at": int(time.time()) + 180,
                     "access_token": secrets.token_urlsafe(32), "refresh_token": secrets.token_urlsafe(32)}
            seeded = False
            try:
                credential.fixture("seed", value)
                seeded = True
                request = {"identityOrigin": origin, "account": value["user_id"], "generations": [{"generation": 0,
                           "accessSha256": hashlib.sha256(value["access_token"].encode()).hexdigest(),
                           "refreshSha256": hashlib.sha256(value["refresh_token"].encode()).hexdigest()}]}
                before = credential.observer.observe(request)
                self.assertEqual(before["persistence"], 3)
                self.assertEqual(before["refreshGeneration"], 0)
                with self.assertRaisesRegex(AssertionError, "must not replace"):
                    credential.fixture("seed", dict(value, refresh_token=secrets.token_urlsafe(32)))
                self.assertEqual(credential.observer.observe(request), before)
            finally:
                if seeded:
                    self.assertTrue(credential.fixture("delete", {"identity_origin": origin})["fixtureCredentialRemoved"])


if __name__ == "__main__":
    unittest.main()
