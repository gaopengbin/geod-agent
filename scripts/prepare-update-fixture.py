"""Prepare signed, non-executable update bytes for the native debug updater."""
from pathlib import Path
import json
import subprocess
import tempfile
import shutil
import os

root = Path(__file__).resolve().parents[1]
fixture = Path(tempfile.mkdtemp(prefix="geod-update-fixture-"))
cli = root / "apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js"
node = shutil.which("node")
key = fixture / "test-signing-key"

def run(arguments):
    result = subprocess.run([node, str(cli), "signer", *arguments], cwd=cli.parent, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise SystemExit(f"Fixture signer failed ({result.returncode}); no key material printed")

run(["generate", "--ci", "--write-keys", str(key)])
payload = fixture / "fixture.bin"
payload.write_bytes(b"GeoD signed update acceptance fixture. This is not an installer and must never execute.\n")
run(["sign", "--private-key-path", str(key), "--app-version", "0.2.1", str(payload)])
(fixture / "tampered.bin").write_bytes(payload.read_bytes() + b"changed after signing\n")
config = {"endpoint": "http://127.0.0.1:16451/manifest", "pubkey": key.with_suffix(".pub").read_text(encoding="utf-8").strip()}
(fixture / "config.json").write_text(json.dumps(config), encoding="utf-8")
(fixture / "mode.txt").write_text("valid", encoding="utf-8")
key.unlink()
print(json.dumps({"fixture": str(fixture), "config": str(fixture / "config.json"), "signedVersion": "0.2.1", "containsInstaller": False}))
