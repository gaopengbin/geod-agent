"""Inspect genuine scheduled database tools while the development window is closed."""
from pathlib import Path
import json
import os
import psutil
import sqlite3
import time

root = Path('artifacts/product-gaps-20261004/database-keys')
saved = json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
providers = ('postgis', 'mysql', 'mariadb', 'oracle')
fixtures = [json.loads((root/(p+'-ready.json')).read_text(encoding='utf-8')) for p in providers]
secrets = []
for provider in providers:
    private = root/'private'/provider
    state = json.loads((private/'state.json').read_text(encoding='utf-8'))
    secrets.extend(state[k] for k in ('password', 'readerPassword', 'keyPassword') if state.get(k))
    secrets.extend(file.read_text(encoding='utf-8') for file in private.glob('*.key'))

database = Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline = time.monotonic()+300
previous = {}
runs = {}
while len(runs) < 2:
    assert not any(p.info['name'] == 'geod-agent-desktop.exe' and '--background-runtime' not in (p.info['cmdline'] or []) for p in psutil.process_iter(['name', 'cmdline'])), 'Foreground must stay closed'
    assert any(p.info['name'] == 'geod-agent-desktop.exe' and '--background-runtime' in (p.info['cmdline'] or []) for p in psutil.process_iter(['name', 'cmdline'])), 'Real companion must stay running'
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        for kind, schedule in [('read', saved['readScheduleId']), ('missing', saved['missingScheduleId'])]:
            if kind in runs:
                continue
            row = db.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1', (schedule,)).fetchone()
            state = row[1] if row else 'waiting_for_due_time'
            if previous.get(kind) != state:
                print(json.dumps(dict(kind=kind, actualCompanionState=state)), flush=True)
                previous[kind] = state
            if row and state not in ('queued', 'running'):
                runs[kind] = dict(run=json.loads(row[2]), events=[json.loads(e[0]) for e in db.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq', (row[0],))])
    if time.monotonic() > deadline:
        raise TimeoutError('Encrypted-key background runs did not finish')
    if len(runs) < 2:
        time.sleep(1)

text = json.dumps(runs, ensure_ascii=False, indent=2)
assert all(secret not in text and json.dumps(secret, ensure_ascii=False)[1:-1] not in text for secret in secrets), 'Private material entered background evidence'
(root/'actual-closed-window-model.json').write_text(text, encoding='utf-8')
read, missing = runs['read'], runs['missing']
assert read['run']['state'] == 'succeeded', read['run'].get('error')
answer = read['run']['result']['text']
for fixture in fixtures:
    assert fixture['marker'] in answer, 'Actual database marker is missing'
tools = [e for e in read['events'] if e.get('type') == 'toolResult' and e.get('tool') in ('data_layer_inspect', 'sql_query')]
assert len(tools) >= 4 and not any(t['result'].get('error') for t in tools)
assert missing['run']['state'] == 'waiting_input', missing['run'].get('error')
blocked = [e for e in missing['events'] if e.get('type') == 'toolResult' and e.get('tool') == 'data_connection_connect' and e.get('result', {}).get('error', {}).get('code') == 'USER_INPUT_REQUIRED']
assert blocked, 'Missing key password must be recorded as required local input'
report = dict(passed=True, cases=[
    dict(name='Actual closed-window Agent reads all four stored encrypted-key databases', passed=True, runId=read['run']['runId'], actualAnswer=answer, actualQueries=len(tools)),
    dict(name='Actual closed-window encrypted-key authentication pauses for local input without creating a connection', passed=True, runId=missing['run']['runId'], state=missing['run']['state']),
    dict(name='Actual background events exclude all fixture passwords and private keys', passed=True),
])
(root/'headless-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(passed=True, cases=len(report['cases']), actualQueries=len(tools))), flush=True)
