"""Verify the actual packaged model run while no application window exists."""
from pathlib import Path
import argparse
import json
import os
import psutil
import sqlite3
import time

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("output")
output = Path(parser.parse_args().output).resolve()
assert output.is_relative_to(repo / "artifacts") and output.name.startswith("release-candidate-")
saved = json.loads((output / "closeout-state.json").read_text(encoding="utf-8"))
candidate = json.loads((output / "candidate.json").read_text(encoding="utf-8"))
executable = (output / f"GeoD-Agent-{candidate['version']}-windows-x64/geod-agent-desktop.exe").resolve()
database = Path(os.environ["APPDATA"]) / "dev.geod-agent.desktop/agent-ai-schedules.sqlite"
deadline = time.monotonic() + 240
previous = None
while True:
    instances = [p for p in psutil.process_iter(["name"]) if p.info["name"] == "geod-agent-desktop.exe"
                 and Path(p.exe()).resolve() == executable]
    assert len(instances) == 1 and instances[0].pid == saved["backgroundPid"] and "--background-runtime" in instances[0].cmdline()
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        row = db.execute("SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1", (saved["scheduleId"],)).fetchone()
        state = row[1] if row else "waiting"
        if previous != state:
            print(json.dumps({"actualClosedWindowState": state}), flush=True)
            previous = state
        if row and state not in ("queued", "running"):
            result = {"run": json.loads(row[2]), "events": [json.loads(event[0]) for event in db.execute("SELECT body FROM ai_events WHERE run=? ORDER BY seq", (row[0],))]}
            break
    if time.monotonic() > deadline:
        raise TimeoutError("Closed-window model did not finish")
    time.sleep(1)
assert result["run"]["state"] == "succeeded"
answer = result["run"]["result"]["text"]
assert saved["marker"] + "PDF" in answer and saved["marker"] + "SQL" in answer
tools = [event for event in result["events"] if event.get("type") == "toolResult"]
assert {"attachment_read", "sql_query"} <= {event.get("tool") for event in tools}
assert all(not event.get("result", {}).get("error") for event in tools if event.get("tool") in ("attachment_read", "sql_query"))
(output / "closeout-actual-closed-window-model.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
report = {"passed": True, "foregroundActuallyClosed": True, "sameCompanion": True, "markersRead": 2,
          "actualCompanionPid": instances[0].pid, "runId": result["run"]["runId"], "installed": False, "published": False}
(output / "closeout-headless.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report), flush=True)
