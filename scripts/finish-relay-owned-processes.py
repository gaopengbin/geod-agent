"""Stop only engines identified by newly owned conversation directories."""
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid

import psutil

repo = Path(__file__).resolve().parents[1]
ownership_path = Path(sys.argv[1]).resolve(strict=True)
allowed = (repo / "artifacts/relay-provider-acceptance-20261005").resolve()
if not ownership_path.is_relative_to(allowed) or ownership_path.name != "native-ownership.json":
    raise SystemExit("Refuse ownership records outside the exact relay acceptance scope")
owned = json.loads(ownership_path.read_text(encoding="utf-8"))
before = json.loads((ownership_path.parent / "native-before.json").read_text(encoding="utf-8"))
if owned["owner"] != before["owner"]:
    raise SystemExit("Refuse a changed owner")
since = datetime.fromisoformat(owned["startedAt"].replace("Z", "+00:00")).timestamp()
native = (Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop/codex-runtime").resolve()
account = native / ("account-" + hashlib.sha256(owned["owner"].encode()).hexdigest())
homes = set()
for fixture in owned["fixtures"]:
    identity = str(uuid.UUID(fixture["id"]))
    if identity in before["conversationIds"]:
        raise SystemExit("Refuse any original user conversation")
    workspace = Path(fixture["directory"]).resolve()
    if workspace.parent != ownership_path.parent or workspace.name != "workspace-" + identity:
        raise SystemExit("Refuse a workspace outside this acceptance run")
    home = (account / ("conversation-" + hashlib.sha256(identity.encode()).hexdigest()[:16])).resolve()
    if not home.is_relative_to(native):
        raise SystemExit("Refuse an engine path outside the native profile")
    homes.add(home)


def roots():
    found = []
    for process in psutil.process_iter(["pid", "create_time", "cmdline", "name"]):
        try:
            if process.info["create_time"] < since or (process.info["name"] or "").lower() != "node.exe":
                continue
            home = Path(process.cwd()).resolve()
            if home not in homes:
                continue
            command = process.info["cmdline"] or []
            if len(command) != 2 or Path(command[1]).resolve() != home / "codex-host.mjs":
                continue
            found.append(process)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    return found


observed = {}
for root in roots():
    try:
        family = [root, *root.children(recursive=True)]
        for process in family:
            created = process.create_time()
            if created < since or process.name().lower() == "geod-agent-desktop.exe":
                raise SystemExit("Refuse an unowned or protected process")
            observed[(process.pid, created)] = process
        # Stop the root first so an idle owned engine cannot spawn new children.
        root.terminate()
    except psutil.NoSuchProcess:
        continue
for (pid, created), process in observed.items():
    try:
        if process.create_time() != created:
            raise SystemExit("Refuse a reused process identifier")
        process.terminate()
    except psutil.NoSuchProcess:
        pass
_, alive = psutil.wait_procs(list(observed.values()), timeout=5)
for process in alive:
    try:
        if (process.pid, process.create_time()) not in observed:
            raise SystemExit("Refuse a changed process identity")
        process.kill()
    except psutil.NoSuchProcess:
        pass
_, alive = psutil.wait_procs(alive, timeout=5)
remaining = [process.pid for process in alive]
remaining.extend(process.pid for process in roots())
print(json.dumps({"passed": not remaining, "ownedEnginesAndChildrenObserved": len(observed),
                  "remaining": sorted(set(remaining)), "originalConversationsExcluded": True,
                  "appStopped": False, "nativeFilesDeleted": False}))
raise SystemExit(1 if remaining else 0)
