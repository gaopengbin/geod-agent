"""Download the real reviewed installer through Tauri's updater SDK over HTTPS.

Only the SDK test runtime runs. It cannot open an app window or execute installation.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import threading
import tomllib
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from sign_update_candidate_for_tests import sign_module
from update_signing_vault import ROOT, candidate_key, generate, public_environment


def sha(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def server_ssl_context():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    # This machine's Python startup injects pip's truststore client adapter.
    # Its wrap_socket checks a peer certificate even for a listening socket,
    # which has no SSL object yet. Use the adapter's stdlib server context;
    # the Rust SDK client still performs strict certificate verification.
    if type(context).__module__.endswith("truststore._api"):
        context = context._ctx
    if not isinstance(context, ssl._SSLContext):
        raise TypeError("The HTTPS fixture requires a native server SSL context")
    return context


def certificates(folder):
    now = datetime.now(timezone.utc)
    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "GeoD updater loopback acceptance CA")])
    ca = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(root_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True).sign(root_key, hashes.SHA256())
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False).sign(root_key, hashes.SHA256())
    root = folder / "fixture-root.pem"
    root.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (folder / "fixture-leaf.pem").write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    (folder / "fixture-tls-key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return root


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    candidate, output, target = args.candidate.resolve(), args.output.resolve(), args.target.resolve()
    for folder in [candidate, output, target]:
        if not folder.is_relative_to(ROOT / "artifacts"):
            raise ValueError("SDK acceptance paths must stay under this repository's artifacts")
    if output.exists():
        raise ValueError("Preserve old evidence and select a fresh output directory")
    receipt = json.loads((candidate / "signing-receipt.json").read_text(encoding="utf-8"))
    installer = candidate / receipt["installer"]
    assert installer.resolve().is_relative_to(candidate) and sha(installer) == receipt["sha256"]
    executable = target / "release/geod-update-sdk-acceptance.exe"
    if not executable.is_file():
        raise ValueError("Compile the actual updater SDK acceptance executable before creating a fixture")
    harness = ROOT / "scripts/update-sdk-harness"
    lock = tomllib.loads((harness / "Cargo.lock").read_text(encoding="utf-8"))
    required_versions = {"tauri": "2.12.0", "tauri-plugin-updater": "2.13.1", "reqwest": "0.13.5"}
    versions = {name: sorted({package["version"] for package in lock["package"] if package["name"] == name}) for name in required_versions}
    if any(versions[name] != [version] for name, version in required_versions.items()):
        raise ValueError("The SDK acceptance lockfile does not contain the reviewed dependency versions")
    shipping_lock_path = ROOT / "apps/geod-agent-desktop/src-tauri/Cargo.lock"
    shipping_lock = tomllib.loads(shipping_lock_path.read_text(encoding="utf-8"))
    shipping_versions = {name: sorted({package["version"] for package in shipping_lock["package"]
                                      if package["name"] == name}) for name in required_versions}
    if any(version not in shipping_versions[name] for name, version in required_versions.items()):
        raise ValueError("The desktop lockfile no longer contains the SDK versions under acceptance")
    signing, public = candidate_key()
    assert public["publicKeyFingerprint"] == receipt["publicKeyFingerprint"]
    signature = Path(str(installer) + ".sig").read_text(encoding="utf-8").strip()
    output.mkdir(parents=True, exist_ok=False)
    (output / "sdk-provenance.json").write_text(json.dumps({
        "executable": str(executable), "executableSha256": sha(executable),
        "sourceSha256": {str(file.relative_to(ROOT)): sha(file) for file in [
            harness / "Cargo.toml", harness / "Cargo.lock", harness / "src/main.rs",
            Path(__file__).resolve(), Path(__file__).with_name("sign_update_candidate_for_tests.py").resolve()
        ]}, "lockedDependencyVersions": versions,
        "desktopLockfile": str(shipping_lock_path.relative_to(ROOT)),
        "desktopLockfileSha256": sha(shipping_lock_path),
        "desktopDependencyVersions": shipping_versions,
        "signedInstallerSha256": receipt["sha256"], "signedInstallerBytes": receipt["bytes"],
        "permanentSigningPublicKeyFingerprint": receipt["publicKeyFingerprint"],
        "compilationAndAcceptanceAreSeparateGates": True
    }, indent=2), encoding="utf-8")
    # Remove the ephemeral TLS key even if fixture preparation or certificate
    # loading fails before the SDK process starts. The SSL context retains it
    # in memory after loading; no signing credential is written here.
    tls = server_ssl_context()
    fixture_tls_key = output / "fixture-tls-key.pem"
    try:
        root_certificate = certificates(output)
        tls.load_cert_chain(output / "fixture-leaf.pem", fixture_tls_key)
    finally:
        fixture_tls_key.unlink(missing_ok=True)
    unsigned_version = output / "missing-version.exe"
    os.link(installer, unsigned_version)
    sign_module().sign(unsigned_version, signing)
    missing_signature = Path(str(unsigned_version) + ".sig").read_text(encoding="utf-8").strip()
    other_public = generate()["publicKey"]
    served = []
    server = None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            served.append({"path": self.path, "at": datetime.now(timezone.utc).isoformat()})
            prefix, separator, mode = self.path.rpartition("/")
            if prefix == "/manifest":
                version = {"wrong-version": "0.2.3", "same-version": "0.2.1", "older-version": "0.2.0"}.get(mode, receipt["version"])
                body = json.dumps({"version": version, "notes": "Local SDK acceptance only", "platforms": {"windows-x86_64": {
                    "signature": missing_signature if mode == "missing-version" else signature,
                    "url": f"https://127.0.0.1:{server.server_port}/payload/{mode}"}}}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif prefix == "/payload":
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("content-length", str(installer.stat().st_size))
                self.end_headers()
                try:
                    with installer.open("rb") as stream:
                        if mode == "truncated":
                            self.wfile.write(stream.read(4096))
                            self.wfile.flush()
                            self.close_connection = True
                            return
                        first = True
                        while chunk := stream.read(256 * 1024):
                            if first and mode == "tampered":
                                chunk = bytes([chunk[0] ^ 1]) + chunk[1:]
                            self.wfile.write(chunk)
                            first = False
                except (ConnectionError, OSError):
                    pass
            else:
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state = {"currentVersion": "0.2.1", "signedVersion": receipt["version"], "bytes": receipt["bytes"], "sha256": receipt["sha256"],
             "rootCertificate": str(root_certificate), "origin": f"https://127.0.0.1:{server.server_port}",
             "publicKey": signing["publicKey"], "otherPublicKey": other_public, "resultPath": str(output / "sdk-result.json")}
    (output / "public-config.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    started = datetime.now(timezone.utc)
    try:
        with (output / "sdk.log").open("w", encoding="utf-8") as log:
            process = subprocess.run([str(executable), str(output / "public-config.json")],
                                     stdout=log, stderr=subprocess.STDOUT, timeout=600,
                                     env=public_environment(),
                                     creationflags=subprocess.CREATE_NO_WINDOW)
        if process.returncode:
            raise ValueError("The actual updater SDK acceptance failed; inspect its local log")
        result = json.loads((output / "sdk-result.json").read_text(encoding="utf-8"))
        assert result["passed"] and len(result["cases"]) == 9
        for mode in ["same-version", "older-version"]:
            assert not any(request["path"] == "/payload/" + mode for request in served)
        assert sha(installer) == receipt["sha256"] and sha(unsigned_version) == receipt["sha256"]
        result.update(startedAt=started.isoformat(), finishedAt=datetime.now(timezone.utc).isoformat(),
                      originalSignedCandidatePreserved=True, fixtureRootInstalledInWindows=False,
                      fixtureTlsPrivateKeyRemoved=True, requests=served)
        (output / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({"passed": True, "cases": 9, "sdkVersion": "2.13.1", "output": str(output), "installed": False}))
    except Exception as error:
        (output / "failure.json").write_text(json.dumps({
            "passed": False, "startedAt": started.isoformat(),
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "errorType": type(error).__name__, "error": str(error),
            "requests": served, "originalSignedCandidatePreserved": sha(installer) == receipt["sha256"],
            "fixtureRootInstalledInWindows": False, "fixtureTlsPrivateKeyRemoved": True,
            "installed": False, "published": False
        }, indent=2), encoding="utf-8")
        raise
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error))
