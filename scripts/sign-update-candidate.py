"""Sign a copy of a reviewed installer. No original artifact, application or channel is changed."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlsplit
from update_signing_vault import ROOT, candidate_key, public_environment, signing_environment


VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")


def reviewed_installer(original, candidate):
    version = candidate["version"]
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise ValueError("A valid release version is required before signing")
    installer = (original / f"GeoD Agent_{version}_x64-setup.exe").resolve()
    if installer.parent != original or not installer.is_file():
        raise ValueError("The installer must be a file inside its reviewed candidate directory")
    return version, installer


def sha(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sign(file, record, version=None):
    cli = ROOT / "apps/geod-agent-desktop/node_modules/@tauri-apps/cli/tauri.js"
    arguments = [shutil.which("node"), str(cli), "signer", "sign"]
    if version is not None:
        arguments.extend(["--app-version", version])
    arguments.append(str(file))
    completed = subprocess.run(arguments, env=signing_environment(record), stdin=subprocess.DEVNULL,
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=180)
    if completed.returncode:
        raise ValueError("The official Tauri signer failed; private output was withheld")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--artifact-base", required=True)
    parser.add_argument("--endpoint", required=True)
    args = parser.parse_args()
    for value in [args.endpoint, args.artifact_base]:
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError("The review channel must use HTTPS without credentials")
    original, output = args.candidate.resolve(), args.output.resolve()
    if not original.is_relative_to(ROOT / "artifacts") or not output.is_relative_to(ROOT / "artifacts") or not output.name.startswith("update-candidate-"):
        raise ValueError("Use reviewed local artifacts and a fresh update-candidate directory")
    if output.exists():
        raise ValueError("Preserve existing update evidence; use a fresh output directory")
    candidate = json.loads((original / "candidate.json").read_text(encoding="utf-8"))
    version, installer = reviewed_installer(original, candidate)
    expected = candidate["artifacts"][installer.name]
    original_sha = sha(installer)
    if expected["sha256"] != original_sha or expected["bytes"] != installer.stat().st_size:
        raise ValueError("The original installer no longer matches the reviewed candidate")
    record, public = candidate_key()
    output.mkdir(parents=True, exist_ok=False)
    copy = output / installer.name
    shutil.copyfile(installer, copy)
    sign(copy, record, version)
    environment = public_environment(dict(os.environ, GEOD_UPDATE_PUBLIC_KEY=record["publicKey"]))
    completed = subprocess.run([shutil.which("node"), str(ROOT / "scripts/update-candidate.mjs"), str(copy), version, args.artifact_base, str(output)],
                               env=environment, capture_output=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW, timeout=180)
    if completed.returncode:
        raise ValueError("The installer signature or signed release version did not verify")
    verified = json.loads((output / "update-verification.json").read_text(encoding="utf-8"))
    if sha(copy) != original_sha or sha(installer) != original_sha or verified["sha256"] != original_sha:
        raise ValueError("The signing operation changed the reviewed installer bytes")
    config = {"GEOD_UPDATE_ENDPOINT": args.endpoint, "GEOD_UPDATE_PUBLIC_KEY": record["publicKey"], "GEOD_UPDATE_ARTIFACT_BASE": args.artifact_base}
    (output / "build-public-config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    (output / "signing-public.json").write_text(json.dumps(public, indent=2), encoding="utf-8")
    receipt = {"passed": True, "installer": copy.name, "version": version, "bytes": expected["bytes"],
               "sha256": original_sha, "originalCandidate": str(original), "originalArtifactsPreserved": True,
               "publicKeyFingerprint": public["publicKeyFingerprint"], "privateKeyPersistedAsPlaintext": False,
               "installerAlreadyEmbedsChannel": False, "requiresSignedChannelBuild": True,
               "endpoint": args.endpoint, "installed": False, "published": False, "channelActivated": False,
               "signerVersion": json.loads((ROOT / "apps/geod-agent-desktop/node_modules/@tauri-apps/cli/package.json").read_text(encoding="utf-8"))["version"]}
    needles = [record["privateKey"].encode(), base64.b64decode(record["privateKey"])]
    for file in output.iterdir():
        if file.is_file() and file != copy and any(secret in file.read_bytes() for secret in needles):
            raise ValueError("A private signing value was found in update evidence")
    (output / "signing-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps(receipt))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error))
