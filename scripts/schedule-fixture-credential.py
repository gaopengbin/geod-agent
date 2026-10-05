"""Seed the fixed synthetic login with the same persistence as keyring on Windows."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import sys
from urllib.parse import urlparse

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location("fixture_observer", Path(__file__).with_name("schedule-fixture-credential-observer.py"))
observer = module_from_spec(spec)
spec.loader.exec_module(observer)
Credential = observer.Credential


def fixture(action, value):
    assert action in ("seed", "delete")
    origin = value["identity_origin"]
    parsed = urlparse(origin)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
    assert not parsed.username and not parsed.password and parsed.path in ("", "/")
    assert not parsed.query and not parsed.fragment
    if action == "seed":
        assert value["user_id"] == "credit-history-native-fixture"
        assert value["access_expires_at"] > 0
        assert len(value["access_token"]) == len(value["refresh_token"]) == 43
    account = "geod-oauth-" + hashlib.sha256(origin.encode()).hexdigest()
    target = account + ".dev.geod-agent.desktop"
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    api.CredFree.argtypes = [ctypes.c_void_p]
    found = ctypes.POINTER(Credential)()
    exists = bool(api.CredReadW(target, 1, 0, ctypes.byref(found)))
    if exists:
        try:
            stored = json.loads(ctypes.string_at(found.contents.CredentialBlob, found.contents.CredentialBlobSize).decode("utf-16-le"))
            assert stored["user_id"] == "credit-history-native-fixture" and stored["identity_origin"] == origin
        finally:
            api.CredFree(found)
    else:
        assert ctypes.get_last_error() == 1168
    if action == "seed":
        assert not exists, "Fixture must not replace an existing credential"
        blob = json.dumps(value, separators=(",", ":")).encode("utf-16-le")
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        # keyring 3.6.3 WinCredential::save_credential uses CRED_PERSIST_ENTERPRISE.
        # Use the same persistence instead of changing it during native renewal.
        record = Credential(Type=1, TargetName=target, UserName=account, Comment="keyring-compatible synthetic QA",
                            CredentialBlobSize=len(blob), CredentialBlob=buffer, Persist=3)
        if not api.CredWriteW(ctypes.byref(record), 0):
            raise ctypes.WinError(ctypes.get_last_error())
    elif exists and not api.CredDeleteW(target, 1, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    if action == "delete":
        assert not api.CredReadW(target, 1, 0, ctypes.byref(found)), "Fixture credential must be removed"
        assert ctypes.get_last_error() == 1168
    return {"fixtureCredential": action, "fixtureCredentialRemoved": action == "delete",
            "credentialPersistence": 3, "realCredentialAccessed": False}


if __name__ == "__main__":
    print(json.dumps(fixture(sys.argv[1], json.load(sys.stdin))))
