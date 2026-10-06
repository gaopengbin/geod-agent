"""One-shot launch bootstrap. No credentials enter config or receipts."""
from pathlib import Path
from contextlib import ExitStack
import json
import os
import sys

import psutil
from windows_detached_process import process_in_job, process_package_identity, spawn_hidden_detached
from windows_explorer_launch import LAUNCHES

config = Path(sys.argv[1]).resolve(strict=True)
assert config.is_relative_to(LAUNCHES.resolve())
assert config.name == "request.json" and config.parent.name.startswith("launch-")
value = json.loads(config.read_text(encoding="utf-8"))
receipt = {"passed": False, "bootstrapPid": os.getpid(), "bootstrapOutsideWindowsJobs": not process_in_job(os.getpid())}
child = None
try:
    with ExitStack() as stack:
        streams = {}
        for key in ("stdoutPath", "stderrPath"):
            path = value[key]
            if path and path not in streams:
                streams[path] = stack.enter_context(Path(path).open("ab"))
        child = spawn_hidden_detached(value["command"], cwd=value["cwd"], env=dict(os.environ), _bootstrap=True,
                                      stdout=streams.get(value["stdoutPath"]),
                                      stderr=streams.get(value["stderrPath"]))
    process = psutil.Process(child.pid)
    receipt["child"] = {"pid": child.pid, "created": process.create_time(), "exe": process.exe()}
    receipt["childOutsideWindowsJobs"] = not process_in_job(child.pid)
    receipt["childPackageIdentity"] = process_package_identity(child.pid)
    receipt["passed"] = True
except BaseException as error:
    if child and child.poll() is None:
        child.terminate()
        child.wait(timeout=15)
    receipt["error"] = str(error)
finally:
    path = config.parent / "result.json"
    temporary = path.with_name("result.json.tmp")
    temporary.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    os.replace(temporary, path)
