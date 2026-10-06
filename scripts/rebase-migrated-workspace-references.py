"""Repair only workspace references into the already copied native profile.

Both old and new directory contents must hash identically. Preserve each old
metadata file in the artifact receipt directory; never delete the source.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import time

import psutil
from windows_detached_process import process_in_job, process_package_identity
from windows_explorer_launch import LAUNCHES

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
assert out.is_relative_to(LAUNCHES.resolve()) and not out.exists()
assert not process_in_job(os.getpid()) and process_package_identity(os.getpid()) is None
root = Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop"
source = Path(os.environ["LOCALAPPDATA"]) / "Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming/dev.geod-agent.desktop"
context = json.loads((LAUNCHES / "current-ui-workspace-reference-context.json").read_text(encoding="utf-8"))
audit = json.loads((LAUNCHES / "profile-json-reference-audit-324821dbb597fb13.json").read_text(encoding="utf-8"))
current = {"workspace-" + hashlib.sha256((context["owner"] + ":" + c).encode()).hexdigest() + ".json" for c in context["conversationIds"]}
assert len(current) == 31
for pid, created in [(75684,1791268191.8117428),(96872,1791268194.512353),(66008,1791268452.0874765),(36592,1791268472.46087)]:
    assert psutil.Process(pid).create_time() == created


def digest(file):
    with file.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def local_path(value):
    text = str(value)
    if text.startswith("\\\\?\\"):
        text = text[4:]
    assert len(text) >= 3 and text[1:3] == ":\\", "Only local drive paths are eligible"
    return Path(text)


def inventory(directory):
    result = {}
    for base, dirs, files in os.walk(directory):
        for name in dirs + files:
            assert not (Path(base) / name).is_symlink() and not (Path(base) / name).is_junction()
        for name in files:
            file = Path(base) / name
            assert file.resolve().is_relative_to(directory.resolve())
            result[file.relative_to(directory).as_posix()] = digest(file)
    return result


report = {"passed": False, "providerCalls": 0, "sourceDeleted": False,
          "currentConversationBindingsChanged": False, "historyEdited": False, "records": []}
out.mkdir(parents=True, exist_ok=False)
prepared = []
for ref in audit["privateAbsoluteReferences"]:
    name = ref["file"]
    assert name not in current and ref["pointer"] == "/directory"
    assert Path(name).name == name and name.startswith("workspace-")
    file = root / name
    before = file.read_bytes()
    value = json.loads(before)
    old_directory = local_path(value["directory"])
    assert old_directory.is_dir() and old_directory.resolve().is_relative_to(source.resolve())
    relative = old_directory.relative_to(source)
    target = root / relative
    assert target.is_dir() and target.resolve().is_relative_to(root.resolve())
    original_inventory = inventory(old_directory)
    assert inventory(target) == original_inventory
    (out / name).write_bytes(before)
    replacement = dict(value, directory=str(target))
    prepared.append((file, before, replacement, old_directory, target, original_inventory))
assert len(prepared) == 17
for file, before, replacement, old_directory, target, original_inventory in prepared:
    assert file.read_bytes() == before
    temporary = file.with_name(file.name + ".workspace-rebase.pending")
    assert not temporary.exists()
    try:
        temporary.write_text(json.dumps(replacement, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, file)
    finally:
        if temporary.exists():
            temporary.unlink()
    after = json.loads(file.read_bytes())
    assert dict(after, directory=json.loads(before)["directory"]) == json.loads(before)
    assert inventory(old_directory) == original_inventory and inventory(target) == original_inventory
    report["records"].append({"file": file.name, "originalSha256": hashlib.sha256(before).hexdigest(),
      "updatedSha256": digest(file), "directoryFilesMatched": len(original_inventory), "sourceContentsUnchanged": True,
      "targetContentsUnchanged": True, "onlyDirectoryFieldChanged": True})
    (out / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
report.update(passed=True, finishedAt=time.time())
(out / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({"passed": True, "rebasedWorkspaceReferences": len(report["records"]),
                  "sourceDeleted": False, "historyEdited": False}), flush=True)
time.sleep(1)
