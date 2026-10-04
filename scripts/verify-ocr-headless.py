"""Read actual companion completion while the real desktop is closed."""
from pathlib import Path
import json
import os
import psutil
import sqlite3
import time

root = Path('artifacts/product-gaps-20261004/document-ocr')
saved = json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
fixtures = json.loads((root/'fixtures.json').read_text(encoding='utf-8'))
database = Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline = time.monotonic()+220
previous = None
def desktop_running():
    return any(process.info['name'] and process.info['name'].lower()=='geod-agent-desktop.exe' and
               '--background-runtime' not in (process.info['cmdline'] or [])
               for process in psutil.process_iter(['name','cmdline']))
while True:
    assert not desktop_running(), 'The actual desktop must stay closed during this acceptance'
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=5) as connection:
        row = connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1',(saved['scheduleId'],)).fetchone()
        state = row[1] if row else 'waiting_for_due_time'
        if state!=previous:
            print(json.dumps({'actualCompanionState':state}),flush=True);previous=state
        if row and state not in ['queued','running']:
            run = json.loads(row[2]);events=[json.loads(item[0]) for item in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq',(row[0],))];break
    if time.monotonic()>deadline: raise TimeoutError('Actual OCR companion turn did not finish')
    time.sleep(1)
(root/'actual-closed-window-model.json').write_text(json.dumps({'run':run,'events':events},ensure_ascii=False,indent=2),encoding='utf-8')
assert run['state']=='succeeded',run.get('error')
for marker in fixtures['markers'].values(): assert marker in run['result']['text']
assert any(event.get('method')=='item/completed' and event['params']['item'].get('type')=='dynamicToolCall' and event['params']['item'].get('tool')=='attachment_read' and event['params']['item'].get('success') is True for event in events)
report={'passed':True,'runId':run['runId'],'cases':[{'name':'Actual closed-window Codex/DeepSeek reads the stored mixed PDF OCR and original native text','passed':True,'actualAnswer':run['result']['text']}]}
(root/'headless-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':True,'runId':run['runId']}),flush=True)
