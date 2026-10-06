"""Read profile location metadata outside the packaged development host."""
from pathlib import Path
import argparse
import json
import os
import time

from windows_detached_process import process_in_job, process_package_identity
from windows_explorer_launch import LAUNCHES

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--private-roaming", type=Path, required=True)
parser.add_argument("--private-local", type=Path, required=True)
args = parser.parse_args()
output = args.output.resolve()
assert output.is_relative_to(LAUNCHES.resolve()) and not output.exists()
assert not process_in_job(os.getpid()) and process_package_identity(os.getpid()) is None


def metadata(root):
    return {"root": str(root), "exists": root.exists(),
            "entryCount": sum(1 for _ in root.iterdir()) if root.exists() else 0,
            "directories": sorted(p.name for p in root.iterdir() if p.is_dir()) if root.exists() else [],
            "workspaceFiles": sum(1 for _ in root.glob("workspace-*.json")) if root.exists() else 0,
            "nativeStoreBytes": {name: (root / name).stat().st_size for name in
                                  ("agent-tasks.sqlite", "agent-ai-schedules.sqlite") if (root / name).exists()}}


report = {"pid": os.getpid(), "outsideWindowsJobs": True, "packageIdentity": None,
          "providerCalls": 0, "userDataModified": False,
          "profiles": {}}
for context, roaming, local in (("independent", Path(os.environ["APPDATA"]), Path(os.environ["LOCALAPPDATA"])),
                                ("codex-private", args.private_roaming, args.private_local)):
    report["profiles"][context] = {kind: metadata(base / "dev.geod-agent.desktop")
                                  for kind, base in (("native", roaming), ("webview", local))}
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
# Let the parent record and verify this exact short-lived process identity.
time.sleep(1)
