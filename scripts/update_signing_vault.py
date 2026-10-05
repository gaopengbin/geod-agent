"""Keep one local release-signing candidate in the Windows credential vault.

The public key and a user-bound DPAPI recovery blob are the only files written.
Existing key identities are preserved; missing state never silently rotates a key.
This module does not configure GitHub, publish a channel or alter an application.
"""
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = "GeoD-Agent.Update-Signing.Candidate.v1"
ENTROPY = b"GeoD Agent release signing candidate v1"
SIGNING_VARIABLES = ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PATH", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")


def public_environment(environment=None):
    """Retain build configuration without passing signing secrets to reviewers."""
    env = dict(os.environ if environment is None else environment)
    for name in SIGNING_VARIABLES:
        env.pop(name, None)
    return env


def write_once(file, data):
    """Publish a complete encrypted/public file without replacing existing state."""
    fd, temporary = tempfile.mkstemp(prefix=file.name + ".", suffix=".pending", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # On Windows rename fails when the destination exists; it never replaces
        # a key identity created by another provisioning process.
        os.rename(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Credential(ctypes.Structure):
    _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def windows_api():
    if os.name != "nt":
        raise ValueError("The local signing candidate requires the Windows credential vault")
    api = ctypes.WinDLL("advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    api.CredFree.argtypes = [ctypes.c_void_p]
    return api


def read_secret():
    api = windows_api()
    value = ctypes.POINTER(Credential)()
    if not api.CredReadW(TARGET, 1, 0, ctypes.byref(value)):
        if ctypes.get_last_error() == 1168:
            return None
        raise ValueError("The local signing credential cannot be read")
    try:
        return json.loads(ctypes.string_at(value.contents.CredentialBlob, value.contents.CredentialBlobSize))
    finally:
        api.CredFree(value)


def write_secret(record):
    api = windows_api()
    data = json.dumps(record, separators=(",", ":")).encode("utf-8")
    if len(data) > 2560:
        raise ValueError("The signing credential exceeds the Windows vault limit")
    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    value = Credential(Type=1, TargetName=TARGET, UserName="geod-release-signing-candidate",
                       Comment="Local candidate only; no published updater channel", Persist=2,
                       CredentialBlobSize=len(data), CredentialBlob=buffer)
    if not api.CredWriteW(ctypes.byref(value), 0):
        raise ValueError("The local signing credential cannot be saved")


def protect(data, decrypt=False):
    api = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    raw = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    entropy_bytes = (ctypes.c_ubyte * len(ENTROPY)).from_buffer_copy(ENTROPY)
    source, entropy, output = Blob(len(data), raw), Blob(len(ENTROPY), entropy_bytes), Blob()
    function = api.CryptUnprotectData if decrypt else api.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob),
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    # CRYPTPROTECT_UI_FORBIDDEN; no machine-wide scope, no dialogs.
    if not function(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(output)):
        raise ValueError("The user-bound signing recovery blob cannot be processed")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def public_record(record):
    document = base64.b64decode(record["publicKey"], validate=True).decode("utf-8").strip().splitlines()
    if len(document) != 2 or not document[0].startswith("untrusted comment:"):
        raise ValueError("The stored signing public key is invalid")
    packet = base64.b64decode(document[1], validate=True)
    if len(packet) != 42 or packet[:2] not in [b"Ed", b"ED"]:
        raise ValueError("The stored public signing packet is invalid")
    return {"schemaVersion": 1, "credentialRef": TARGET, "createdAt": record["createdAt"],
            "publicKey": record["publicKey"], "publicKeyFingerprint": hashlib.sha256(packet).hexdigest(),
            "published": False, "channelActivated": False, "privateKeyProtection": "Windows credential vault",
            "recoveryProtection": "Windows user-bound DPAPI", "crossMachineRecovery": False}


def generate():
    cli = ROOT / "apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js"
    completed = subprocess.run([shutil.which("node"), str(cli), "signer", "generate", "--ci"],
                               env=public_environment(), capture_output=True, stdin=subprocess.DEVNULL, encoding="utf-8",
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=30)
    if completed.returncode:
        raise ValueError("The official Tauri signer could not generate a candidate; private output was withheld")
    keys = {}
    for candidate in re.findall(r"[A-Za-z0-9+/]{60,}={0,2}", completed.stdout):
        try:
            lines = base64.b64decode(candidate, validate=True).decode("utf-8").splitlines()
        except (ValueError, UnicodeError):
            continue
        if len(lines) == 2 and lines[0].startswith("untrusted comment: rsign encrypted secret key"):
            keys["privateKey"] = candidate
        if len(lines) == 2 and lines[0].startswith("untrusted comment: minisign public key:"):
            keys["publicKey"] = candidate
    if set(keys) != {"privateKey", "publicKey"}:
        raise ValueError("The official signer output format changed; no candidate key was persisted")
    keys["createdAt"] = datetime.now(timezone.utc).isoformat()
    public_record(keys)
    return keys


def candidate_key(provision=False):
    folder = Path(os.environ["LOCALAPPDATA"]) / "GeoD/release-signing/candidate-v1"
    public_file, backup = folder / "public.json", folder / "recovery.dpapi"
    record = read_secret()
    if record is None:
        if not provision:
            raise ValueError("Provision the local signing candidate before signing an artifact")
        if public_file.exists() or backup.exists():
            if not backup.is_file() or (public_file.exists() and not public_file.is_file()):
                raise ValueError("Existing signing state is incomplete; it was preserved without generating a replacement key")
            # The first provisioning may stop after the encrypted backup is
            # durable. Rebuild its public identity from that same key.
            record = json.loads(protect(backup.read_bytes(), decrypt=True))
        else:
            record = generate()
    public = public_record(record)
    if public_file.exists():
        saved = json.loads(public_file.read_text(encoding="utf-8"))
        if saved != public:
            raise ValueError("The local signing key does not match its preserved public identity")
    if backup.exists():
        recovered = json.loads(protect(backup.read_bytes(), decrypt=True))
        if recovered != record:
            raise ValueError("The local signing credential and recovery blob do not match")
    if provision:
        folder.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            write_once(backup, protect(json.dumps(record, separators=(",", ":")).encode("utf-8")))
        if not public_file.exists():
            write_once(public_file, json.dumps(public, indent=2).encode("utf-8"))
        write_secret(record)
    if read_secret() != record or json.loads(protect(backup.read_bytes(), decrypt=True)) != record:
        raise ValueError("The signing vault and encrypted recovery state did not verify")
    return record, public


def signing_environment(record):
    env = public_environment()
    env["TAURI_SIGNING_PRIVATE_KEY"] = record["privateKey"]
    env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] = record.get("privateKeyPassword", "")
    return env


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--provision", action="store_true")
    args = parser.parse_args()
    try:
        _, public = candidate_key(args.provision)
        print(json.dumps(public, indent=2))
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error))
