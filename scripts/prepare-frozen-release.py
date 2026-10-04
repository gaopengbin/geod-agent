"""Freeze source hashes and build one reviewable candidate without installing it."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("--installer-compression", choices=["lzma", "zlib"], default="lzma")
args = parser.parse_args()
output = Path(args.output).resolve()
assert output.is_relative_to(REPO / "artifacts") and output.name.startswith("release-candidate-")
assert not output.exists(), "Keep previous candidate outputs intact."
evidence = output.with_name(output.name + "-build-evidence")
assert not evidence.exists(), "Keep the build evidence for previous candidates intact."
evidence.mkdir(parents=True)


def snapshot():
    names = subprocess.check_output(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=REPO
    ).decode("utf-8").split("\0")
    prefixes = ("apps/geod-agent-desktop/", "crates/", "packages/", "services/geod-agent-model-gateway/", "vendor/", "scripts/", ".github/")
    files = {}
    for name in sorted(set(names)):
        file = REPO / name
        if name and (name.startswith(prefixes) or name in {"Cargo.toml", "Cargo.lock", "LICENSE"}) and file.is_file():
            assert file.resolve().is_relative_to(REPO)
            files[name] = hashlib.sha256(file.read_bytes()).hexdigest()
    assert files and "apps/geod-agent-desktop/src-tauri/src/lib.rs" in files
    return files


frozen = snapshot()
record = {"at": datetime.now(timezone.utc).isoformat(), "candidate": str(output),
          "gitHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO).decode().strip(),
          "files": frozen, "installed": False, "published": False, "chargingEnabled": False}
(evidence / "source-freeze.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
print(json.dumps({"sourceFrozen": True, "files": len(frozen), "candidate": output.name}), flush=True)
with (evidence / "build.log").open("wb") as log:
    result = subprocess.run([sys.executable, "-X", "utf8", str(REPO / "scripts/build-release-candidate.py"),
                             "--output", str(output), "--installer-compression", args.installer_compression], cwd=REPO, stdout=log, stderr=subprocess.STDOUT)
if result.returncode:
    raise SystemExit("Candidate build failed; preserved detailed build.log. Exit: " + str(result.returncode))
current = snapshot()
changed = sorted(name for name in set(frozen) | set(current) if frozen.get(name) != current.get(name))
assert not changed, "Source changed during the build: " + ", ".join(changed)
(output / "source-freeze.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
print(json.dumps({"built": True, "sourceUnchanged": True, "installed": False, "published": False}), flush=True)
