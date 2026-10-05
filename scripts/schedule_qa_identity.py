"""Validate a current-source QA build before reusing it in native acceptance."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE = "dev.geod-agent.credit-history-qa"
AUTH_SOURCE = "apps/geod-agent-desktop/src-tauri/src/services.rs"


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read_build(path, check_current_source=True):
    path = Path(path).resolve()
    artifacts = (ROOT / "artifacts/schedule-stability-native-20261005").resolve()
    assert path.is_relative_to(artifacts) and path.name.startswith("fixture-")
    receipt = json.loads((path / "current-source-qa-build.json").read_text(encoding="utf-8"))
    assert receipt["passed"] and receipt["identifier"] == PROFILE
    assert receipt["changedProductInputs"] == []
    assert digest(path / "tauri-qa.json") == receipt["configSha256"]
    config = json.loads((path / "tauri-qa.json").read_text(encoding="utf-8"))
    assert config["identifier"] == PROFILE
    binary = path / "target/release/geod-agent-desktop.exe"
    assert digest(binary) == receipt["qaExecutableSha256"] and PROFILE.encode() in binary.read_bytes()
    assert AUTH_SOURCE in receipt["sourceSnapshotBeforeBuild"]
    if check_current_source:
        source_config = json.loads((ROOT / "apps/geod-agent-desktop/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
        assert receipt["version"] == source_config["version"]
    for name, expected in receipt["sourceSnapshotBeforeBuild"].items():
        relative = Path(name)
        assert not relative.is_absolute() and ".." not in relative.parts
        assert name.startswith(("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/"))
        if check_current_source:
            file = (ROOT / relative).resolve()
            assert file.is_relative_to(ROOT.resolve()) and digest(file) == expected, "QA source changed: " + name
    return receipt


def read_run(root):
    root = Path(root).resolve()
    assert root.is_relative_to((ROOT / "artifacts/schedule-stability-native-20261005").resolve())
    payload = json.loads((root / "payload.json").read_text(encoding="utf-8"))
    build_root = Path(payload["currentSourceQaBuild"]).resolve()
    receipt = read_build(build_root, check_current_source=False)
    assert digest(build_root / "current-source-qa-build.json") == payload["currentSourceQaBuildSha256"]
    assert receipt["qaExecutableSha256"] == payload["qaExecutableSha256"]
    assert digest(root / "target/release/geod-agent-desktop.exe") == payload["qaExecutableSha256"]
    return payload
