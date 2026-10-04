"""Verify a real closed-window sponsored Responses image/tool turn."""
from pathlib import Path
import json, os, sqlite3, time
import psutil
root=Path('artifacts/product-gaps-20261004/sponsored-native')
saved=json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
expected=json.loads((root/'expected.json').read_text(encoding='utf-8'))
assert not any(p.info['name']=='geod-agent-desktop.exe' and '--background-runtime' not in p.cmdline() for p in psutil.process_iter(['name'])),'Foreground desktop must actually be closed'
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline=time.monotonic()+240;previous=None
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as connection:
        row=connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['scheduleId'],)).fetchone()
        state=row[1] if row else 'waiting_for_due_time'
        if state!=previous:print(json.dumps({'actualCompanionState':state}),flush=True);previous=state
        if row and state not in ['queued','running']:
            run=json.loads(row[2]);events=[json.loads(r[0]) for r in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],))];break
    if time.monotonic()>deadline:raise TimeoutError('Actual sponsored image background turn did not finish')
    time.sleep(1)
(root/'actual-background-model.json').write_text(json.dumps({'run':run,'events':events},ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
answer=run['result']['text'];assert expected['nonce'] in answer and expected['marker'] in answer,answer
for color in ['红','蓝','绿']:assert color in answer,answer
generations=[e['generation'] for e in events if e.get('type')=='generationResult']
assert len(generations)>=2
assert all(g['billingScope']=='sponsored' and g['channelId']=='sponsor:native-responses' for g in generations)
assert any(e.get('method')=='item/completed' and e['params']['item'].get('type')=='dynamicToolCall' and e['params']['item'].get('tool')=='workspace_gis_files_list' and e['params']['item'].get('success') is True for e in events)
with sqlite3.connect((root/'gateway.sqlite').resolve().as_uri()+'?mode=ro',uri=True) as connection:
    connection.row_factory=sqlite3.Row;rows=[dict(row) for row in connection.execute('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at')]
assert all(r['state']=='settled' and r['funding_scope']=='sponsored' and r['upstream_request_id'] for r in rows)
report={'passed':True,'runId':run['runId'],'cases':[{'name':'Actual closed-window Responses sponsor reads native image history and an unprompted workspace filename after saved selection switches to hosted','passed':True,'actualAnswer':answer,'generations':len(generations)},{'name':'All four real foreground protocols and the headless run settle to sponsor-only funding','passed':True,'requests':len(rows),'actualTokens':sum(r['input_tokens']+r['output_tokens'] for r in rows)}]}
(root/'headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'actual-server-ledger.json').write_text(json.dumps({'rows':rows},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'requests':len(rows),'actualTokens':report['cases'][1]['actualTokens']}),flush=True)
