"""Read-only discovery of this verifier's wait-only Windows command processes."""
import datetime
import json
import os
import re
import sys
from pathlib import Path

import psutil

value = json.load(sys.stdin)
nonce = value["nonce"]
assert re.fullmatch(r"\d{13}", nonce), "Invalid fixture nonce"
directory = Path(value["directory"]).resolve(strict=True)
assert directory.name.startswith("geod-stop-fork-") and directory.parent == Path(os.environ["TEMP"]).resolve(), "Refuse unrelated workspace"
commands = []
for process in psutil.process_iter():
    try:
        if process.name().lower() not in ("pwsh.exe", "powershell.exe"):
            continue
        command = " ".join(process.cmdline())
        marker = next((label for label in ("A", "B") if f"STOP_{label}_{nonce}" in command), None)
        if marker is None:
            continue
        assert Path(process.cwd()).resolve() == directory, "Fixture marker in a different workspace"
        commands.append({"pid": process.pid, "created": process.create_time(), "exe": process.exe(), "parentPid": process.ppid(), "marker": marker})
    except psutil.NoSuchProcess:
        continue
print(json.dumps({"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "nonce": nonce, "directory": str(directory), "commands": commands}))
