"""Read the actual scoped companion ledger while its desktop window is closed."""
import json
import os
from pathlib import Path
import sqlite3
import time

root=Path('artifacts/product-gaps-20261004/plugin-mcp-hooks')
saved=json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'/'agent-ai-schedules.sqlite'
deadline=time.monotonic()+220
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
    if time.monotonic()>deadline:raise TimeoutError('The actual companion did not finish its scoped MCP Hook schedule')
    time.sleep(1)
result={'run':run,'events':events}
(root/'actual-background-model.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
assert run['result']['status']=='completed'
assert saved['marker'] in run['result']['text']
hooks=[e for e in events if e.get('method','').startswith('hook/')]
assert any(e['method']=='hook/completed' and e['params']['run']['status']=='completed' and e['params']['run']['eventName']=='sessionStart' for e in hooks)
assert not any(e['params']['run']['status'] in ('failed','blocked') for e in hooks)
native=[e for e in events if e.get('type')=='pluginHookMcpResult']
assert len(native)>=5 and all(e['success'] and not e.get('error') for e in native),native
audit=[json.loads(line) for line in Path(saved['auditFile']).read_text(encoding='utf-8').splitlines()]
assert sum(r.get('arguments',{}).get('event')=='SessionStart' for r in audit)>=2
assert all(not r['bridgeVisible'] for r in audit if r['type']=='started')
report={'passed':True,'cases':[{'name':'Actual closed-window Codex and DeepSeek execute native MCP lifecycle automation','passed':True,'runId':run['runId'],'actualAnswer':run['result']['text'],'nativeMcpCalls':len(native)}]}
(root/'headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'nativeMcpCalls':len(native)}),flush=True)
