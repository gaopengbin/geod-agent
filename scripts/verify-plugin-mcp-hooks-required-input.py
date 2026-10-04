"""Inspect actual background-required-input state, without changing the ledger."""
import json
import os
from pathlib import Path
import sqlite3
import time
root=Path('artifacts/product-gaps-20261004/plugin-mcp-hooks')
saved=json.loads((root/'restart-state.json').read_text(encoding='utf-8'))
database=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'/'agent-ai-schedules.sqlite'
deadline=time.monotonic()+100
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as db:
        row=db.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['requiredInputScheduleId'],)).fetchone()
        if row and row[1] not in ('queued','running'):
            run=json.loads(row[2])
            events=[json.loads(v[0]) for v in db.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],)).fetchall()]
            break
    if time.monotonic()>deadline:raise TimeoutError('Background Hook did not settle its required-input state')
    time.sleep(.5)
report={'passed':False,'run':run,'events':events}
(root/'required-input-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='waiting_input',run
assert any(e.get('type')=='pluginHookMcpResult' and e.get('error')=='USER_INPUT_REQUIRED' for e in events),events
assert not any(e.get('type') in ('model','generationResult') for e in events),'A model was requested after the required-input event'
report['passed']=True
report['cases']=[{'name':'Actual closed-window MCP-required-input error pauses the schedule before model generation','passed':True,'runId':run['runId']}]
(root/'required-input-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'state':run['state']}),flush=True)
