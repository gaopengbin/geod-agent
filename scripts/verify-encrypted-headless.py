"""Real companion model reading while no foreground development app exists."""
from pathlib import Path
import json,os,psutil,sqlite3,time
root=Path('artifacts/product-gaps-20261004/encrypted-documents')
saved=json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
fixtures=json.loads((root/'fixtures.json').read_text(encoding='utf-8'))
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline=time.monotonic()+240;previous=None
while True:
    assert not any(p.info['name']=='geod-agent-desktop.exe' and '--background-runtime' not in (p.info['cmdline'] or []) for p in psutil.process_iter(['name','cmdline'])),'The foreground must stay closed'
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as db:
        row=db.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['scheduleId'],)).fetchone()
        state=row[1] if row else 'waiting_for_due_time'
        if state!=previous:print(json.dumps(dict(actualCompanionState=state)),flush=True);previous=state
        if row and state not in ['queued','running']:
            run=json.loads(row[2]);events=[json.loads(event[0]) for event in db.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],))];break
    if time.monotonic()>deadline:raise TimeoutError('Encrypted attachment companion read did not finish')
    time.sleep(1)
(root/'actual-closed-window-model.json').write_text(json.dumps(dict(run=run,events=events),ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
answer=run['result']['text']
for marker in [*fixtures['markers'].values(),fixtures['scanMarker']]:assert marker in answer
tools=[event['params']['item'] for event in events if event.get('method')=='item/completed' and event.get('params',{}).get('item',{}).get('type')=='dynamicToolCall' and event['params']['item'].get('tool')=='attachment_read']
assert len(tools)>=8 and all(tool.get('success') is True for tool in tools)
result=dict(passed=True,runId=run['runId'],cases=[dict(name='Actual closed-window Codex/DeepSeek rereads all eight extracted encrypted attachments without any password',passed=True,toolCalls=len(tools),actualAnswer=answer)])
(root/'headless-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(dict(passed=True,runId=run['runId'],toolCalls=len(tools))),flush=True)
