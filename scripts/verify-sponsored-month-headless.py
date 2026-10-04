"""Inspect real closed-window model receipts without re-opening the desktop."""
from pathlib import Path
import json
import os
import sqlite3
import time
import psutil

root=Path('artifacts/product-gaps-20261004/sponsored-months').resolve()
saved=json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
file=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline=time.monotonic()+240
previous=None
while True:
    visible=[p for p in psutil.process_iter(['name']) if p.info['name']=='geod-agent-desktop.exe' and '--background-runtime' not in p.cmdline()]
    assert not visible,'Foreground desktop re-opened during headless acceptance'
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=5) as db:
        row=db.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['scheduleId'],)).fetchone()
        state=row[1] if row else 'waiting_for_due_time'
        if previous!=state:
            print(json.dumps(dict(actualCompanionState=state)),flush=True)
            previous=state
        if row and state not in ['queued','running']:
            run=json.loads(row[2])
            events=[json.loads(row[0]) for row in db.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],))]
            break
    if time.monotonic()>deadline:
        raise TimeoutError('Actual monthly-sponsored headless turn did not finish')
    time.sleep(1)
(root/'actual-background-model.json').write_text(json.dumps(dict(run=run,events=events),ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
assert saved['marker'] in run['result']['text']
generations=[event['generation'] for event in events if event.get('type')=='generationResult']
assert len(generations)>=2
assert all(g['billingScope']=='sponsored' and g['channelId']=='sponsor:qa-sponsored' and g['channelRevision']==saved['sponsor']['revision'] for g in generations)
assert any(e.get('method')=='item/completed' and e['params']['item'].get('type')=='dynamicToolCall' and e['params']['item'].get('tool')=='workspace_boundaries_list' and e['params']['item'].get('success') is True for e in events)
with sqlite3.connect((root/'gateway.sqlite').as_uri()+'?mode=ro',uri=True) as db:
    db.row_factory=sqlite3.Row
    rows=[dict(row) for row in db.execute('SELECT generation_id,conversation_id,state,input_tokens,output_tokens,upstream_request_id,funding_scope,sponsor_id,sponsor_revision,created_at FROM model_generations ORDER BY created_at,generation_id')]
assert len(rows)>=4
assert all(r['state']=='settled' and r['funding_scope']=='sponsored' and r['sponsor_id']=='qa-sponsored' and r['sponsor_revision']==saved['sponsor']['revision'] and r['upstream_request_id'] for r in rows)
report=dict(passed=True,cases=[dict(name='Actual closed-window Codex and DeepSeek read the random file using the saved monthly sponsor',passed=True,runId=run['runId'],generations=len(generations),actualAnswer=run['result']['text']),dict(name='Every foreground and closed-window generation settles only in the sponsored ledger',passed=True,generations=len(rows),actualTokens=sum(r['input_tokens']+r['output_tokens'] for r in rows))])
(root/'headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'actual-server-ledger.json').write_text(json.dumps(dict(rows=rows),ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(dict(passed=True,generations=len(rows))),flush=True)
