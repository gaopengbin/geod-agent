"""Read the actual native companion ledger while the desktop stays closed."""
from pathlib import Path
import json
import os
import sqlite3
import time
import psutil
root=Path('artifacts/product-gaps-20261004/database-tls')
qa=json.loads((root/'qa-state.json').read_text())
fixtures=[json.loads((root/(provider+'-fixture.json')).read_text()) for provider in ('mysql','mariadb','sqlserver','oracle')]
secrets=[]
for provider in ('mysql','mariadb','sqlserver','oracle'):
    private=root/'private'/provider
    state=json.loads((private/'state.json').read_text())
    secrets += [state['password'],state['readerPassword']]
    secrets += [file.read_text() for file in private.glob('*.key')]
assert not any(p.info['name']=='geod-agent-desktop.exe' and '--background-runtime' not in p.cmdline() for p in psutil.process_iter(['name'])),'Foreground must really be closed'
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline=time.monotonic()+240
previous=None
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as connection:
        row=connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(qa['backgroundScheduleId'],)).fetchone()
        state=row[1] if row else 'waiting'
        if state!=previous:
            print(json.dumps({'actualCompanionState':state}),flush=True);previous=state
        if row and state not in ('queued','running'):
            run=json.loads(row[2]);events=[json.loads(r[0]) for r in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],))];break
    if time.monotonic()>deadline:raise TimeoutError('Closed-window database Agent did not finish')
    time.sleep(1)
text=json.dumps({'run':run,'events':events},ensure_ascii=False,indent=2)
assert all(secret not in text for secret in secrets)
(root/'actual-tls-background.json').write_text(text,encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
answer=run['result']['text']
assert all(f['marker'] in answer for f in fixtures), 'The actual answer is missing a database marker'
calls=[e['params']['item'] for e in events if e.get('method')=='item/completed' and e['params']['item'].get('type')=='dynamicToolCall' and e['params']['item'].get('tool')=='sql_query']
assert len(calls)>=4 and all(c.get('success') is True for c in calls)
report={'passed':True,'cases':[{'name':'Actual closed-window Agent reads all four saved TLS database connections','passed':True,'runId':run['runId'],'tools':len(calls),'actualAnswer':answer},{'name':'The real background events exclude passwords and private keys','passed':True}]}
(root/'agent-headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'cases':2,'sqlQueries':len(calls)}))
