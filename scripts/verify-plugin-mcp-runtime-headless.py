"""Read the actual native companion's database after the desktop window closes."""
import json
import os
from pathlib import Path
import sqlite3
import time
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('artifacts/product-gaps-20261004/plugin-mcp-runtime')
saved = json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
database = Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'/'agent-ai-schedules.sqlite'
deadline = time.monotonic()+200
previous = None
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True, timeout=5) as connection:
        row = connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1', (saved['scheduleId'],)).fetchone()
        state = row[1] if row else 'waiting_for_due_time'
        if state != previous:
            print(json.dumps({'actualCompanionState':state}), flush=True)
            previous = state
        if row and state not in ('queued', 'running'):
            run = json.loads(row[2])
            events = [json.loads(item[0]) for item in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq', (row[0],)).fetchall()]
            break
    if time.monotonic() > deadline:
        raise TimeoutError('Actual companion did not finish the plugin MCP request')
    time.sleep(1)
(root/'actual-background-model.json').write_text(json.dumps({'run':run,'events':events}, ensure_ascii=False, indent=2), encoding='utf-8')
assert run['state'] == 'succeeded', run.get('error')
assert saved['marker'] in run['result']['text']
if saved.get('skillMarker'):
    assert saved['skillMarker'] in run['result']['text']
    assert any(event.get('method') == 'item/completed' and event['params']['item'].get('type') == 'dynamicToolCall' and event['params']['item'].get('tool') == 'skill_read' and event['params']['item'].get('success') is True for event in events)
assert any(event.get('method') == 'item/completed' and event['params']['item'].get('type') == 'dynamicToolCall' and event['params']['item'].get('tool') == 'mcp_call' and event['params']['item'].get('success') is True for event in events)
report = {'passed':True,'cases':[{'name':'Actual closed-window companion and model read configured native MCP data', 'passed':True, 'runId':run['runId'], 'actualAnswer':run['result']['text']} ]}
(root/'headless-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed':True}), flush=True)
