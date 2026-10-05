"""Build an isolated QA identity from recorded current source, without bundling."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

from release_build_identity import release_environment, source_config
from update_signing_vault import public_environment

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/geod-agent-desktop"


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def snapshot():
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT).decode("utf-8").split("\0")
    return {name: sha(ROOT / name) for name in sorted(set(names)) if name and
            name.startswith(("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/")) and (ROOT / name).is_file()}


def main():
    base = source_config(DESKTOP / "src-tauri")
    root = ROOT / "artifacts/schedule-stability-native-20261005" / ("fixture-" + secrets.token_hex(8))
    release = root / "target/release"
    release.mkdir(parents=True, exist_ok=False)
    config = {"identifier": "dev.geod-agent.credit-history-qa", "productName": "GeoD Agent Credential QA",
              "app": {"windows": [{"label": "main", "title": "GeoD Agent · 续期验收", "decorations": False,
                                    "width": 1100, "height": 820, "minWidth": 960, "minHeight": 660}]},
              "bundle": {"createUpdaterArtifacts": False}}
    config_path = root / "tauri-qa.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    before = snapshot()
    receipt = {"passed": False, "startedAt": datetime.now(timezone.utc).isoformat(), "installed": False,
               "published": False, "sourceSnapshotBeforeBuild": before, "version": base["version"],
               "identifier": config["identifier"], "configSha256": sha(config_path)}
    report = root / "current-source-qa-build.json"
    report.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    env = public_environment(release_environment(os.environ))
    for name in ("GEOD_UPDATE_ENDPOINT", "GEOD_UPDATE_PUBLIC_KEY", "GEOD_UPDATE_ARTIFACT_BASE"):
        env.pop(name, None)
    env["CARGO_BUILD_JOBS"] = "2"
    env["CARGO_TARGET_DIR"] = str(DESKTOP / "src-tauri/target")
    try:
        with (root / "build.log").open("w", encoding="utf-8") as log:
            child = subprocess.run([shutil.which("node"), str(DESKTOP / "node_modules/@tauri-apps/cli/tauri.js"),
                                    "build", "--ci", "--no-bundle", "--config", str(config_path)],
                                   cwd=DESKTOP, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        receipt["exitCode"] = child.returncode
        if child.returncode:
            raise ValueError("Current-source QA build failed; inspect its preserved build log")
        after = snapshot()
        receipt["changedProductInputs"] = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
        if receipt["changedProductInputs"]:
            raise ValueError("Product source changed during QA compilation")
        binary = (DESKTOP / "src-tauri/target/release/geod-agent-desktop.exe").read_bytes()
        if config["identifier"].encode() not in binary:
            raise ValueError("The isolated QA identity is absent from the executable")
        executable = release / "geod-agent-desktop.exe"
        executable.write_bytes(binary)
        runtime = release / "codex-runtime"
        shutil.copytree(ROOT / "artifacts/release-candidate-0.2.2-updater-public-build-20261005/GeoD-Agent-0.2.2-windows-x64/codex-runtime", runtime)
        manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
        for name, item in manifest["files"].items():
            file = (runtime / name).resolve()
            if not file.is_relative_to(runtime.resolve()) or sha(file) != item["sha256"]:
                raise ValueError("The frozen QA runtime differs from its manifest")
        receipt.update(passed=True, qaExecutableSha256=sha(executable), runtimeFilesVerified=len(manifest["files"]),
                       finishedAt=datetime.now(timezone.utc).isoformat())
    except Exception as cause:
        receipt["failure"] = str(cause)
        raise
    finally:
        report.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"passed": True, "output": str(root), "qaExecutableSha256": receipt["qaExecutableSha256"], "installed": False}), flush=True)


if __name__ == "__main__":
    main()
