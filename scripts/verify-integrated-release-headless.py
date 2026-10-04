"""Read the actual packaged companion's ledger while its UI is closed."""
from pathlib import Path
import argparse
import json
import os
import psutil
import sqlite3
import time

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
output = Path(parser.parse_args().output).resolve()
assert output.is_relative_to(repo/'artifacts') and output.name.startswith('release-candidate-')
root = repo/'artifacts/product-gaps-20261004/integrated-release'
saved = json.loads((output/'integrated-qa-state.json').read_text(encoding='utf-8'))
fixtures = json.loads((root/'fixtures.json').read_text(encoding='utf-8'))
postgis = json.loads((root/'postgis-ready.json').read_text(encoding='utf-8'))
candidate = json.loads((output/'candidate.json').read_text(encoding='utf-8'))
executable = (output/f"GeoD-Agent-{candidate['version']}-windows-x64/geod-agent-desktop.exe").resolve()
passwords = list(json.loads((root/'private/document-passwords.json').read_text(encoding='utf-8')).values())
private = json.loads((root/'private/postgis/state.json').read_text(encoding='utf-8'))
passwords.extend(private[key] for key in ('password','readerPassword','keyPassword') if private.get(key))
secrets = passwords+[file.read_text(encoding='utf-8') for file in (root/'private/postgis').glob('*.key')]
database = Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline = time.monotonic()+420
previous = None
while True:
    instances = [p for p in psutil.process_iter(['name']) if p.info['name'] == 'geod-agent-desktop.exe' and Path(p.exe()).resolve() == executable]
    assert len(instances) == 1 and '--background-runtime' in instances[0].cmdline(), 'Only the actual candidate companion may remain running'
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        row = db.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1', (saved['scheduleId'],)).fetchone()
        state = row[1] if row else 'waiting_for_due_time'
        if state != previous:
            print(json.dumps(dict(actualCompanionState=state)), flush=True)
            previous = state
        if row and state not in ('queued','running'):
            result = dict(run=json.loads(row[2]), events=[json.loads(event[0]) for event in db.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq', (row[0],))])
            break
    if time.monotonic() > deadline:
        raise TimeoutError('Actual candidate companion did not finish its run')
    time.sleep(1)
text = json.dumps(result, ensure_ascii=False, indent=2)
assert all(secret not in text and json.dumps(secret, ensure_ascii=False)[1:-1] not in text for secret in secrets), 'Private fixture material entered background events'
(output/'integrated-actual-closed-window-model.json').write_text(text, encoding='utf-8')
assert result['run']['state'] == 'succeeded'
answer = result['run']['result']['text']
for marker in [*fixtures['markers'].values(), postgis['marker']]:
    assert marker in answer, 'The actual model omitted a fixture marker'
tools = [event for event in result['events'] if event.get('type') == 'toolResult']
reads = [tool for tool in tools if tool.get('tool') == 'attachment_read']
queries = [tool for tool in tools if tool.get('tool') in ('data_layer_inspect','sql_query')]
assert len(reads) >= 7 and len(queries) >= 2 and all(not query['result'].get('error') for query in queries)
report = dict(passed=True, foregroundActuallyClosed=True, actualCompanionPid=instances[0].pid,
              runId=result['run']['runId'], actualAnswer=answer, actualAttachmentReads=len(reads),
              actualDatabaseQueries=len(queries), audioMarkerIsUserCorrection=True,
              privateMaterialAbsent=True, installed=False, published=False, cleanWindowsVerified=False)
(output/'integrated-headless.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(passed=True, actualAttachmentReads=len(reads), actualDatabaseQueries=len(queries))), flush=True)
