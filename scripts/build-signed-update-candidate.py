"""Build a local signed channel candidate using the preserved Windows vault key.

The key exists only in process memory/environment. Logs are redacted before they
are displayed or written. This tool never installs, uploads or activates a URL.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from release_build_identity import source_config
from release_inventory import inventory
from update_signing_vault import ROOT, candidate_key
from update_signing_vault import public_environment
from build_release_candidate_for_tests import load_builder

PUBLIC_FIELDS = {"GEOD_UPDATE_ENDPOINT", "GEOD_UPDATE_PUBLIC_KEY", "GEOD_UPDATE_ARTIFACT_BASE"}


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_snapshot():
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT, env=public_environment()).decode("utf-8").split("\0")
    prefixes = ("apps/geod-agent-desktop/", "crates/", "packages/", "services/geod-agent-model-gateway/", "vendor/", "scripts/", ".github/")
    return {name: sha(ROOT / name) for name in sorted(set(names)) if name and
            (name.startswith(prefixes) or name in {"Cargo.toml", "Cargo.lock", "LICENSE"}) and (ROOT / name).is_file()}


def build_input(name):
    return (name.startswith(("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/", "scripts/prepare-"))
            or name in {"Cargo.toml", "Cargo.lock", "LICENSE", "scripts/build-signed-update-candidate.py",
                        "scripts/build-release-candidate.py", "scripts/release_inventory.py", "scripts/release_build_identity.py",
                        "scripts/package-release-candidate.py", "scripts/update_signing_vault.py", "scripts/update-candidate.mjs",
                        "scripts/sync-codex-tools.mjs", "scripts/build_release_candidate_for_tests.py",
                        "scripts/sign-update-candidate.py", "scripts/sign_update_candidate_for_tests.py"})


def private_values(record):
    encoded = record["privateKey"]
    document = base64.b64decode(encoded, validate=True)
    values = [encoded.encode(), document]
    for line in document.splitlines():
        if not line.startswith(b"untrusted comment:") and len(line) > 20:
            values.append(line)
            values.append(base64.b64decode(line, validate=True))
    for value in tuple(values):
        try:
            values.append(value.decode("utf-8").encode("utf-16-le"))
        except UnicodeError:
            pass
    return sorted(set(values), key=len, reverse=True)


def redact(text, values):
    """Filter a complete output buffer, including wrapped/escaped key text."""
    normalized, positions = [], []
    index = 0
    escapes = ["\\r", "\\n", "\\t", "\\u0009", "\\u000a", "\\u000b", "\\u000c", "\\u000d", "\\u0020"]
    escapes += [value.encode("utf-16-le").decode("utf-8") for value in tuple(escapes)]
    while index < len(text):
        token = next((value for value in escapes if text[index:index + len(value)].lower() == value), None)
        if token:
            index += len(token)
        elif text[index].isspace():
            index += 2 if text[index + 1:index + 2] == "\0" else 1
        else:
            normalized.append(text[index])
            positions.append(index)
            index += 1
    normalized = "".join(normalized)
    spans = []
    for value in values:
        try:
            secret = value.decode("utf-8")
        except UnicodeError:
            continue
        needle = strip_formatting(secret.encode()).decode("utf-8")
        start = normalized.find(needle) if needle else -1
        while start >= 0:
            spans.append((positions[start], positions[start + len(needle) - 1] + 1))
            start = normalized.find(needle, start + len(needle))
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    for start, end in reversed(merged):
        text = text[:start] + "[signing value withheld]" + text[end:]
    return text


def formatting_tokens():
    tokens = []
    for text in ["\\r", "\\n", "\\t", "\\u0009", "\\u000a", "\\u000b", "\\u000c", "\\u000d", "\\u0020"]:
        variants = {text}
        for index, character in enumerate(text):
            if character.isalpha():
                variants = {value[:index] + letter + value[index + 1:] for value in variants for letter in (character.lower(), character.upper())}
        for token in variants:
            tokens.extend([token.encode(), token.encode("utf-16-le")])
    return tokens


def strip_formatting(data):
    for token in formatting_tokens():
        data = data.replace(token, b"")
    for character in " \t\n\r\v\f":
        data = data.replace(character.encode("utf-16-le"), b"")
    return data.translate(None, b" \t\n\r\v\f")


def safe_normalization_cut(data):
    tokens = formatting_tokens()
    tokens.extend(character.encode("utf-16-le") for character in " \t\n\r\v\f")
    cut = max(0, len(data) - 16)
    while cut:
        sizes = [size for token in tokens for size in range(1, len(token))
                 if cut >= size and data.startswith(token, cut - size)]
        if not sizes:
            break
        cut -= max(sizes)
    return cut


def contains_private(file, values):
    retain = max(map(len, values)) - 1
    formatted = [value for value in map(strip_formatting, values) if value]
    normal_retain = max(map(len, formatted)) - 1
    previous = normalized_previous = pending = b""

    def inspect(block):
        nonlocal normalized_previous
        combined = normalized_previous + strip_formatting(block)
        if any(value in combined for value in formatted):
            return True
        normalized_previous = combined[-normal_retain:] if normal_retain else b""
        return False

    with file.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            combined = previous + block
            if any(value in combined for value in values):
                return True
            previous = combined[-retain:] if retain else b""
            combined = pending + block
            cut = safe_normalization_cut(combined)
            if inspect(combined[:cut]):
                return True
            pending = combined[cut:]
    return inspect(pending)


def verify_logs(logs, values):
    for file in logs.rglob("*"):
        if file.is_file() and contains_private(file, values):
            raise ValueError("Private signing material was found in a build log; candidate review is blocked")


def frozen_assets():
    original = ROOT / "artifacts/release-candidate-0.2.2-credits-20261004"
    record = json.loads((original / "candidate.json").read_text(encoding="utf-8"))
    files = {str(original / name): entry["sha256"] for name, entry in record["artifacts"].items()}
    signed = ROOT / "artifacts/update-candidate-0.2.2-20261005"
    for name in ["GeoD Agent_0.2.2_x64-setup.exe", "GeoD Agent_0.2.2_x64-setup.exe.sig"]:
        file = signed / name
        files[str(file)] = sha(file)
    for name, expected in files.items():
        if sha(name) != expected:
            raise ValueError("A frozen candidate asset differs from its reviewed hash")
    return files


def verify_built_candidate(output, public, config, frozen, values):
    candidate = json.loads((output / "candidate.json").read_text(encoding="utf-8"))
    build = json.loads((output / "build-receipt.json").read_text(encoding="utf-8"))
    verified = json.loads((output / "update-verification.json").read_text(encoding="utf-8"))
    version = candidate["version"]
    installer = output / f"GeoD Agent_{version}_x64-setup.exe"
    if verified["sha256"] != candidate["artifacts"][installer.name]["sha256"] or sha(installer) != verified["sha256"]:
        raise ValueError("The signed copied installer differs from the packaged candidate")
    if verified["signedVersion"] != version or verified["publicKeyFingerprint"] != public["publicKeyFingerprint"]:
        raise ValueError("The signed candidate version or key identity differs from the preserved key")
    if build["updateChannel"] != {"configured": True, "endpoint": config["GEOD_UPDATE_ENDPOINT"], "publicKeyFingerprint": public["publicKeyFingerprint"]}:
        raise ValueError("The candidate build receipt does not match the reviewed channel")
    executable = output / f"GeoD-Agent-{version}-windows-x64/geod-agent-desktop.exe"
    data = executable.read_bytes()
    embedded = {"endpoint": config["GEOD_UPDATE_ENDPOINT"].encode() in data,
                "publicKey": config["GEOD_UPDATE_PUBLIC_KEY"].encode() in data}
    if not all(embedded.values()):
        raise ValueError("The actual candidate executable does not contain the reviewed channel identity")
    for file in output.rglob("*"):
        if file.is_file() and contains_private(file, values):
            raise ValueError("Private signing material was found in a candidate asset; publication is blocked")
    for name, expected in frozen.items():
        if sha(name) != expected:
            raise ValueError("A frozen candidate asset changed during the new build")
    return {"version": version, "installerSha256": verified["sha256"],
            "executableSha256": sha(executable), "embeddedChannel": embedded,
            "frozenAssetsPreserved": True, "candidateHasNoPrivateSigningMaterial": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--logs", required=True, type=Path)
    args = parser.parse_args()
    output, logs, public_file = args.output.resolve(), args.logs.resolve(), args.public_config.resolve()
    if not output.is_relative_to(ROOT / "artifacts") or not output.name.startswith("release-candidate-") or output.exists():
        raise ValueError("Use a fresh local release-candidate output directory")
    if not logs.is_relative_to(ROOT / "artifacts") or logs.exists() or logs == output or logs.is_relative_to(output):
        raise ValueError("Use a fresh separate local build log directory")
    if not public_file.is_relative_to(ROOT / "artifacts"):
        raise ValueError("Use the reviewed artifact's public channel configuration")
    config = json.loads(public_file.read_text(encoding="utf-8"))
    if set(config) != PUBLIC_FIELDS:
        raise ValueError("The build configuration must contain only the three public channel fields")
    native = ROOT / "apps/geod-agent-desktop/src-tauri"
    app = source_config(native)
    resources = inventory(ROOT)
    record, public = candidate_key()
    if config["GEOD_UPDATE_PUBLIC_KEY"] != public["publicKey"]:
        raise ValueError("The reviewed public key differs from the preserved Windows signing identity")
    values = private_values(record)
    frozen = frozen_assets()
    if shutil.disk_usage(ROOT).free < 8 * 1024 ** 3:
        raise ValueError("At least 8 GiB of free space is required for a separate review candidate")
    logs.mkdir(parents=True, exist_ok=False)
    sources = source_snapshot()
    freeze = {"at": datetime.now(timezone.utc).isoformat(), "candidate": str(output), "files": sources,
              "recordKind": "pre-build source and script hash snapshot", "publicConfig": config,
              "publicConfigSha256": sha(public_file), "runtimeInputs": resources,
              "temporaryBundlerConfig": load_builder().bundle_config(config, True, "lzma"),
              "buildEnvironmentPublic": {**config, "CARGO_BUILD_JOBS": "2", "CARGO_TARGET_DIR": str(native / "target")},
              "installed": False, "published": False}
    (logs / "source-freeze.json").write_text(json.dumps(freeze, indent=2), encoding="utf-8")
    receipt = {"startedAt": datetime.now(timezone.utc).isoformat(), "phase": "preflight",
               "passed": False, "identifier": app["identifier"], "version": app["version"],
               "candidate": str(output), "publicConfig": config, "publicKeyFingerprint": public["publicKeyFingerprint"],
               "resources": resources, "frozenAssets": frozen, "jobs": 2,
               "privateKeySource": "existing Windows credential vault; no key provision", "installed": False,
               "published": False, "channelActivated": False, "sourceFrozenBeforeBuild": True,
               "preBuildSourceFreeze": str(logs / "source-freeze.json"), "preBuildSourceFreezeSha256": sha(logs / "source-freeze.json")}
    receipt_file = logs / "result.json"

    def save():
        receipt_file.write_text(json.dumps(receipt, indent=2), encoding="utf-8")

    save()
    # This child compiles and packages. Only the separate official signer in
    # build-release-candidate receives the vault value, after compilation.
    environment = public_environment()
    environment.update(config)
    environment["CARGO_BUILD_JOBS"] = "2"
    environment["CARGO_TARGET_DIR"] = str(native / "target")
    environment.pop("CARGO_BUILD_TARGET", None)
    command = [sys.executable, "-X", "utf8", str(ROOT / "scripts/build-release-candidate.py"),
               "--signed-update", "--output", str(output)]
    receipt['signingMode'] = 'detached-cli-after-public-build'
    receipt["phase"] = "building"
    save()
    print(json.dumps({"phase": "building", "candidate": str(output), "logs": str(logs), "sourceFrozenBeforeBuild": True}), flush=True)
    try:
        with (logs / "build.log").open("w", encoding="utf-8") as log:
            child = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
            receipt["buildPid"] = child.pid
            save()
            # A wrapped key may span many lines. Keep output in memory until
            # filtering the whole buffer, before any display or file write.
            captured = child.stdout.read()
            safe = redact(captured, values)
            log.write(safe)
            log.flush()
            print(safe, end="", flush=True)
            code = child.wait()
        receipt["exitCode"] = code
        if code:
            raise ValueError("The signed candidate build failed; inspect the redacted build log")
        receipt["phase"] = "verifying"
        save()
        receipt.update(verify_built_candidate(output, public, config, frozen, values))
        current = source_snapshot()
        changed = sorted(name for name in set(sources) | set(current) if sources.get(name) != current.get(name))
        changed_inputs = [name for name in changed if build_input(name)]
        receipt.update(changedSources=changed, changedBuildInputs=changed_inputs)
        if changed_inputs or inventory(ROOT) != resources:
            raise ValueError("Actual build source or runtime inputs changed; candidate review is blocked")
        receipt["buildInputsUnchangedAcrossBuild"] = True
        verify_logs(logs, values)
        receipt.update(passed=True, phase="complete", completedAt=datetime.now(timezone.utc).isoformat())
        save()
        print(json.dumps({"passed": True, "candidate": str(output), "receipt": str(receipt_file),
                          "installed": False, "published": False, "channelActivated": False}))
    except (OSError, ValueError, KeyError, TypeError) as error:
        receipt.update(phase="failed", failure=redact(str(error), values), completedAt=datetime.now(timezone.utc).isoformat())
        save()
        raise ValueError(receipt["failure"]) from None
    finally:
        environment.clear()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error))
