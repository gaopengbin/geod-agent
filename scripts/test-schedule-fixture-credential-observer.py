"""Refuse production or ambiguous origins before opening the Windows vault."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fixture_observer", Path(__file__).with_name("schedule-fixture-credential-observer.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class OriginBoundaryTests(unittest.TestCase):
    def test_unsafe_origins_never_open_the_vault(self):
        for origin in ["https://geod.laogao.xyz", "http://localhost:5000", "http://127.0.0.2:5000",
                       "https://127.0.0.1:5000", "http://127.0.0.1", "http://127.0.0.1:5000/private",
                       "http://user:password@127.0.0.1:5000", "http://127.0.0.1:5000?other=1",
                       "http://127.0.0.1:5000#other"]:
            with self.subTest(origin=origin), patch.object(observer.ctypes, "WinDLL") as vault:
                with self.assertRaises((AssertionError, ValueError)):
                    observer.observe({"identityOrigin": origin, "account": "credit-history-native-fixture"})
                vault.assert_not_called()

    def test_real_owner_is_rejected_even_on_loopback(self):
        with patch.object(observer.ctypes, "WinDLL") as vault:
            with self.assertRaises(AssertionError):
                observer.observe({"identityOrigin": "http://127.0.0.1:5000", "account": "real-user"})
            vault.assert_not_called()


if __name__ == "__main__":
    unittest.main()
