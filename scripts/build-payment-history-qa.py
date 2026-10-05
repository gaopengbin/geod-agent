"""Compile a payment-only native QA identity without installing or signing."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

from release_build_identity import release_environment
from update_signing_vault import public_environment

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/geod-agent-desktop"


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def inputs():
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT).decode("utf-8").split("\0")
    source = {name: sha(ROOT / name) for name in sorted(set(names)) if name and
              name.startswith(("apps/", "crates/", "packages/", "vendor/")) and (ROOT / name).is_file()}
    for directory in [DESKTOP / "dist", DESKTOP / "src-tauri/resources"]:
        for file in directory.rglob("*"):
            if file.is_file():
                source[file.relative_to(ROOT).as_posix()] = sha(file)
    return source


def main():
    base = ROOT / "artifacts/payment-history-native-20261005"
    output = base / ("build-" + secrets.token_hex(8))
    output.mkdir(parents=True, exist_ok=False)
    config = {"identifier": "dev.geod-agent.cash-history-qa", "productName": "GeoD Agent Payment QA",
              "bundle": {"active": False, "resources": [], "createUpdaterArtifacts": False},
              "app": {"windows": [{"label": "main", "title": "GeoD Agent Payment QA", "decorations": False,
                                    "width": 1100, "height": 820, "minWidth": 960, "minHeight": 660}]}}
    (output / "tauri-qa.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    env = public_environment(release_environment(os.environ))
    env["TAURI_CONFIG"] = json.dumps(config)
    env["CARGO_TARGET_DIR"] = str(base / "target")
    env["CARGO_BUILD_JOBS"] = "4"
    before = inputs()
    receipt = {"passed": False, "identifier": config["identifier"], "scope": "payment-only QA, runtimes not bundled",
               "startedAt": datetime.now(timezone.utc).isoformat(), "sourceBefore": before,
               "installed": False, "published": False}
    try:
        for phase, command in [
            ("tests", ["cargo", "test", "--locked", "--manifest-path", "apps/geod-agent-desktop/src-tauri/Cargo.toml", "services::credit_history::tests", "--lib"]),
            ("binary", ["cargo", "build", "--locked", "--manifest-path", "apps/geod-agent-desktop/src-tauri/Cargo.toml", "--features", "tauri/custom-protocol", "--bin", "geod-agent-desktop"]),
        ]:
            print(json.dumps({"phase": phase, "output": str(output)}), flush=True)
            with (output / (phase + ".log")).open("w", encoding="utf-8") as log:
                run = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            receipt[phase + "Exit"] = run.returncode
            if run.returncode:
                raise ValueError("Native QA " + phase + " failed; log retained")
        after = inputs()
        receipt["changedInputs"] = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
        if receipt["changedInputs"]:
            raise ValueError("Product inputs changed during compilation")
        binary = base / "target/debug/geod-agent-desktop.exe"
        data = binary.read_bytes()
        if config["identifier"].encode() not in data:
            raise ValueError("Native binary does not contain the QA identity")
        frozen = output / "geod-agent-desktop.exe"
        frozen.write_bytes(data)
        receipt.update(passed=True, executable=str(frozen), executableSha256=sha(frozen), embeddedFrontend=True,
                       finishedAt=datetime.now(timezone.utc).isoformat())
    except Exception as cause:
        receipt["failure"] = str(cause)
        raise
    finally:
        (output / "result.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "output": str(output), "executableSha256": receipt["executableSha256"]}), flush=True)


if __name__ == "__main__":
    main()
