"""Read actual completed companion events and the independent gateway ledger."""
import json
import os
from pathlib import Path
import sqlite3
import time

root = Path('artifacts/product-gaps-20261004/sponsored-channels')
saved = json.loads((root / 'restart-state.json').read_text(encoding='utf-8'))
database = Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/agent-ai-schedules.sqlite'
deadline = time.monotonic() + 220
previous = None
while True:
    with sqlite3.connect(database.as_uri()+'?mode=ro', uri=True, timeout=5) as connection:
        row = connection.execute('SELECT id,state,body FROM ai_runs WHERE schedule=? ORDER BY scheduled_at DESC LIMIT 1', (saved['scheduleId'],)).fetchone()
        state = row[1] if row else 'waiting_for_due_time'
        if state != previous:
            print(json.dumps(dict(actualCompanionState=state)), flush=True)
            previous = state
        if row and state not in ['queued', 'running']:
            run = json.loads(row[2])
            events = [json.loads(value[0]) for value in connection.execute('SELECT body FROM ai_events WHERE run=? ORDER BY seq', (row[0],))]
            break
    if time.monotonic() > deadline:
        raise TimeoutError('Actual sponsored companion schedule did not finish')
    time.sleep(1)

(root/'actual-background-model.json').write_text(json.dumps(dict(run=run, events=events), ensure_ascii=False, indent=2), encoding='utf-8')
assert run['state'] == 'succeeded', run.get('error')
assert saved['marker'] in run['result']['text']
generations = [event['generation'] for event in events if event.get('type') == 'generationResult']
assert len(generations) >= 2
assert all(value['billingScope'] == 'sponsored' and value['channelId'] == 'sponsor:qa-sponsored' and value['channelRevision'] == saved['sponsor']['revision'] and value['selectedModel'] == 'deepseek-flash' for value in generations)
assert any(event.get('method') == 'item/completed' and event['params']['item'].get('type') == 'dynamicToolCall' and event['params']['item'].get('tool') == 'workspace_gis_files_list' and event['params']['item'].get('success') is True for event in events)
with sqlite3.connect((root/'gateway.sqlite').resolve().as_uri()+'?mode=ro', uri=True) as connection:
    connection.row_factory = sqlite3.Row
    rows = [dict(row) for row in connection.execute('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at')]
assert len(rows) >= 4
assert all(row['state'] == 'settled' and row['funding_scope'] == 'sponsored' and row['sponsor_id'] == 'qa-sponsored' and row['upstream_request_id'] for row in rows)
report = dict(passed=True, cases=[dict(name='Actual closed-window model keeps the scheduled sponsor snapshot after the conversation switches to hosted', passed=True, runId=run['runId'], actualAnswer=run['result']['text'], generations=len(generations)), dict(name='Actual provider usage is funded only by the sponsor and does not enter the hosted ledger', passed=True, generations=len(rows), actualTokens=sum(r['input_tokens']+r['output_tokens'] for r in rows))])
(root/'headless-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
(root/'actual-server-ledger.json').write_text(json.dumps(dict(rows=rows), ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(passed=True, generations=len(rows))), flush=True)
