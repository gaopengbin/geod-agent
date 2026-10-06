"""Read only the three operational ledgers for private host directory references.

Classify structured path values separately from mentions in historic text. Do
not return any command, prompt, result text, credential value or blob content.
"""
from pathlib import Path
import argparse
import json
import os
import re
import sqlite3
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
private = re.compile(r"openai\.codex_[^/]+/localcache/", re.IGNORECASE)
ledgers = {"agent-tasks/tasks.sqlite": ["tasks", "events"],
           "agent-ai-schedules.sqlite": ["ai_schedules", "ai_runs", "ai_events"],
           "agent-tasks.sqlite": ["background_commands"]}
report = {"completed": False, "passed": False, "providerCalls": 0, "userDataModified": False,
          "sqliteReadOnly": True, "sourceContentReturned": False, "ledgers": [], "privateReferences": []}


def normalize(value):
    return value.replace("\\", "/").removeprefix("//?/").strip()


def locate(value, pointer):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from locate(child, pointer + "/" + str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from locate(child, pointer + "/" + str(index))
    elif isinstance(value, str):
        normalized = normalize(value)
        if re.match(r"^[a-zA-Z]:/", normalized) and private.search(normalized):
            yield pointer


for name, tables in ledgers.items():
    file = root / name
    assert file.is_file(), "The original operational ledger is missing: " + name
    db = sqlite3.connect(file.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        current = {"file": name, "quickCheck": "ok", "tables": []}
        for table in tables:
            assert re.fullmatch(r"[a-z_]+", table)
            columns = [row[1] for row in db.execute('PRAGMA table_info("' + table + '")')]
            assert columns
            summary = {"table": table, "rows": 0, "textMentions": 0, "structuredReferences": 0}
            for row in db.execute('SELECT rowid,* FROM "' + table + '"'):
                summary["rows"] += 1
                rowid = row[0]
                values = dict(zip(columns, row[1:]))
                identifiers = {key: values[key] for key in ("id", "conversation", "conversation_id", "owner", "user_id", "state") if key in values}
                for column, cell in values.items():
                    if not isinstance(cell, str):
                        continue
                    normalized = normalize(cell)
                    mentions = bool(private.search(re.sub(r"/+", "/", normalized)))
                    if not mentions:
                        continue
                    summary["textMentions"] += 1
                    try:
                        decoded = json.loads(cell)
                    except ValueError:
                        decoded = cell
                    pointers = list(locate(decoded, "/" + column))
                    summary["structuredReferences"] += len(pointers)
                    if pointers:
                        report["privateReferences"].append({"ledger": name, "table": table, "rowid": rowid,
                          "identifiers": identifiers, "pointers": pointers,
                          "recordState": decoded.get("status") if isinstance(decoded, dict) else values.get("state")})
            current["tables"].append(summary)
        report["ledgers"].append(current)
    finally:
        db.close()
operational = [item for item in report["privateReferences"]
               if item["table"] not in ("events", "ai_events")]
report.update(completed=True, passed=not operational, finishedAt=time.time(),
              operationalPrivateReferences=len(operational),
              retainedHistoricalRecords=len(report["privateReferences"]) - len(operational))
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report), flush=True)
time.sleep(1)
