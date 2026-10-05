"""Observe generations only for an explicitly loopback synthetic QA login.

No credential values are returned. Production identity origins are rejected
before Windows vault access; the stored account must be the fixed fake owner.
"""
import ctypes
from ctypes import wintypes
import hashlib
import json
import sys
from urllib.parse import urlparse


class Credential(ctypes.Structure):
    _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]


def observe(value):
    origin = value["identityOrigin"]
    parsed = urlparse(origin)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
    assert not parsed.username and not parsed.password and parsed.path in ("", "/")
    assert not parsed.query and not parsed.fragment
    assert value["account"] == "credit-history-native-fixture"
    account = "geod-oauth-" + hashlib.sha256(origin.encode()).hexdigest()
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredFree.argtypes = [ctypes.c_void_p]
    found = ctypes.POINTER(Credential)()
    if not api.CredReadW(account + ".dev.geod-agent.desktop", 1, 0, ctypes.byref(found)):
        assert ctypes.get_last_error() == 1168
        return {"fixtureCredentialExists": False, "realCredentialAccessed": False}
    try:
        raw = ctypes.string_at(found.contents.CredentialBlob, found.contents.CredentialBlobSize).decode("utf-16-le")
        stored = json.loads(raw)
        assert stored["identity_origin"] == origin and stored["user_id"] == value["account"]
        def generation(field):
            digest = hashlib.sha256(stored[field + "_token"].encode()).hexdigest()
            return next((item["generation"] for item in value["generations"] if item[field + "Sha256"] == digest), None)
        written = (found.contents.LastWritten.dwHighDateTime << 32) | found.contents.LastWritten.dwLowDateTime
        return {"fixtureCredentialExists": True, "accessGeneration": generation("access"),
                "refreshGeneration": generation("refresh"), "expiresAt": stored["access_expires_at"],
                "persistence": found.contents.Persist, "lastWrittenUnixSeconds": written / 10000000 - 11644473600,
                "realCredentialAccessed": False, "credentialValuesReturned": False}
    finally:
        api.CredFree(found)


if __name__ == "__main__":
    print(json.dumps(observe(json.load(sys.stdin))))
