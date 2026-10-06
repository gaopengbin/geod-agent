"""Copy the existing development profile out of a packaged host, without overwrite.

Run outside all host jobs and package identities. The original files remain in
place; every copied byte and the unchanged source are checked before launching.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import shutil

import psutil
from windows_detached_process import process_in_job, process_package_identity
from windows_explorer_launch import LAUNCHES


def index(root):
    rows = {}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            folder = Path(parent) / name
            assert not folder.is_symlink() and not folder.is_junction(), "Linked profile directories require a separate review"
        for name in files:
            file = Path(parent) / name
            assert not file.is_symlink()
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                while data := stream.read(1024 * 1024):
                    digest.update(data)
            rows[file.relative_to(root).as_posix()] = {"bytes": file.stat().st_size, "sha256": digest.hexdigest()}
    return rows


def write(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


parser = argparse.ArgumentParser()
parser.add_argument("--source-cache", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--copy", action="store_true")
args = parser.parse_args()
output = args.output.resolve()
assert output.is_relative_to(LAUNCHES.resolve()) and not output.exists()
assert not process_in_job(os.getpid()) and process_package_identity(os.getpid()) is None
source = args.source_cache.resolve(strict=True)
packages = (Path(os.environ["LOCALAPPDATA"]) / "Packages").resolve()
assert source.is_relative_to(packages) and source.name == "LocalCache"
assert source.parent.name == "OpenAI.Codex_2p2nqsd0c76g0"
assert not any(p.info["name"] == "geod-agent-desktop.exe" for p in psutil.process_iter(["name"]))
report = {"passed": False, "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "outsideWindowsJobs": True, "packageIdentity": None, "providerCalls": 0,
          "sourceDeleted": False, "registryModified": False, "installerModified": False,
          "copyRequested": args.copy, "profiles": []}
try:
    pairs = [(source / "Roaming/dev.geod-agent.desktop", Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop"),
             (source / "Local/dev.geod-agent.desktop", Path(os.environ["LOCALAPPDATA"]) / "dev.geod-agent.desktop"),
             (source / "Local/GeoD Agent/dev-logs", Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/dev-logs")]
    # Check every destination before creating any target directory.
    for old, new in pairs:
        assert old.is_dir() and not old.is_symlink() and not old.is_junction()
        allowed = Path(os.environ["APPDATA"]) if old.parent.name == "Roaming" else Path(os.environ["LOCALAPPDATA"])
        assert new.resolve().is_relative_to(allowed.resolve())
        assert not new.exists(), "An independent profile already exists; automatic merge/overwrite refused"
    for old, new in pairs:
        before = index(old)
        row = {"source": str(old), "destination": str(new), "destinationExisted": False,
               "files": len(before), "bytes": sum(x["bytes"] for x in before.values()), "copied": False}
        report["profiles"].append(row)
        write(output, report)
        if args.copy:
            shutil.copytree(old, new, copy_function=shutil.copy2, dirs_exist_ok=False)
            after = index(new)
            assert after == before, "Copied development profile differs from its source"
            assert index(old) == before, "Original development files changed during copy"
            row.update(copied=True, allFileHashesMatch=True, originalFileHashesUnchanged=True,
                       manifestSha256=hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest())
        write(output, report)
    report["passed"] = True
except BaseException as error:
    report["error"] = str(error)
    raise
finally:
    report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write(output, report)
