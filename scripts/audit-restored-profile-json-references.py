"""Read durable JSON metadata in the independent profile; report no content.

Exclude reconstructed runtime/plugin dependencies, logs, backup archives and
encrypted credential files. This is a bounded JSON reference audit, not a scan
of SQLite histories or arbitrary user workspace files.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import time

from windows_detached_process import process_in_job, process_package_identity
from windows_explorer_launch import LAUNCHES

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
output = args.output.resolve()
assert output.is_relative_to(LAUNCHES.resolve()) and not output.exists()
assert not process_in_job(os.getpid()) and process_package_identity(os.getpid()) is None
root = Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop"
assert root.is_dir()
paths = list(root.glob("*.json"))
directories = ["data-inputs", "sql-inputs", "online-inputs", "chat-attachments", "chat-images", "plugin-packages", "plugin-data"]
for name in directories:
    for directory, children, files in os.walk(root / name):
        children[:] = [child for child in children if child not in ("node_modules", ".git", ".tmp", "__pycache__", "vendor")]
        paths.extend(Path(directory) / file for file in files if file.endswith(".json"))
private = re.compile(r"openai\.codex_[^/]+/localcache/", re.IGNORECASE)
report = {"passed": False, "outsideWindowsJobs": True, "packageIdentity": None,
          "userDataModified": False, "providerCalls": 0, "jsonFiles": 0, "jsonBytes": 0,
          "sourceContentReturned": False, "filesWithPrivateMentions": [], "privateAbsoluteReferences": [],
          "unreadableOrInvalidJson": [], "excludedSqliteAndArchives": True, "documentRecords": [], "imageRecords": []}


def references(value, pointer=""):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from references(child, pointer + "/" + str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from references(child, pointer + "/" + str(index))
    elif isinstance(value, str):
        normalized = value.replace("\\", "/").removeprefix("//?/").strip()
        if re.match(r"^[a-zA-Z]:/", normalized) and private.search(normalized):
            yield pointer


for file in sorted(set(paths)):
    relative = file.relative_to(root).as_posix()
    try:
        assert file.resolve().is_relative_to(root.resolve())
        assert file.stat().st_size <= 8 * 1024 * 1024
        data = file.read_bytes()
        value = json.loads(data)
        report["jsonFiles"] += 1
        report["jsonBytes"] += len(data)
        if private.search(data.decode("utf-8").replace("\\", "/")):
            report["filesWithPrivateMentions"].append(relative)
        for pointer in references(value):
            report["privateAbsoluteReferences"].append({"file": relative, "pointer": pointer})
        if relative.startswith("chat-attachments/") and isinstance(value, dict) and "attachment" in value:
            attachment = value["attachment"]
            if value.get("published"):
                report["documentRecords"].append({"id": attachment["id"], "conversationId": attachment["conversationId"],
                  "kind": attachment["kind"], "sha256": attachment["sha256"], "textSha256": attachment["textSha256"],
                  "characters": attachment["characters"], "ownerScopedDirectory": file.parent.name})
        if relative.startswith("chat-images/") and isinstance(value, dict) and "mimeType" in value:
            report["imageRecords"].append({"id": value["id"], "conversationId": value["conversationId"],
              "sha256": value["sha256"], "ownerScopedDirectory": file.parent.name})
    except (OSError, ValueError, AssertionError, KeyError) as error:
        report["unreadableOrInvalidJson"].append({"file": relative, "errorType": type(error).__name__})
report["passed"] = not report["privateAbsoluteReferences"] and not report["unreadableOrInvalidJson"]
report["finishedAt"] = time.time()
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({key: value for key, value in report.items() if key not in ("documentRecords", "imageRecords")}), flush=True)
time.sleep(1)
