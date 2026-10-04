"""Read the real companion's scoped schedule and event ledger while its window is closed."""
import json
import os
from pathlib import Path
import sqlite3
import time

root=Path('artifacts/product-gaps-20261004/plugin-hooks')
saved=json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'/'agent-ai-schedules.sqlite'
deadline=time.monotonic()+200
previous=None
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as connection:
        row=connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['scheduleId'],)).fetchone()
        state=row[1] if row else 'waiting_for_due_time'
        if state!=previous:
            print(json.dumps({'actualCompanionState':state}),flush=True)
            previous=state
        if row and state not in ('queued','running'):
            run=json.loads(row[2])
            events=[json.loads(item[0]) for item in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],)).fetchall()]
            break
    if time.monotonic()>deadline:raise TimeoutError('The actual companion did not finish the scoped schedule')
    time.sleep(1)
result={'run':run,'events':events}
(root/'actual-background-model.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
assert run['result']['status']=='completed'
assert saved['marker'] in run['result']['text']
hooks=[event for event in events if event.get('method','').startswith('hook/')]
assert any(event['method']=='hook/completed' and event['params']['run']['status']=='completed' and event['params']['run']['eventName']=='sessionStart' for event in hooks)
assert not any(event['params']['run']['status'] in ('failed','blocked') for event in hooks)
records=[json.loads(line) for line in (Path(saved['dataRoot'])/'events.jsonl').read_text(encoding='utf-8').splitlines()]
assert sum(record['event']['hook_event_name']=='SessionStart' for record in records)>=2
assert all(record['bridgeVisible'] is False for record in records)
report={'passed':True,'cases':[{'name':'Actual closed-window companion runs reviewed plugin hooks and delivers their output to the real model','passed':True,'runId':run['runId'],'actualAnswer':run['result']['text'],'nativeHookEvents':len(hooks)}]}
(root/'headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'nativeHookEvents':len(hooks)}),flush=True)
