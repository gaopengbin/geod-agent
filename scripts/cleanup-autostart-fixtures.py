"""Disable only schedules whose conversation has this acceptance run's workspace folder."""
from pathlib import Path
import importlib.util, json, os, sqlite3
helper = Path(__file__).with_name('background-runtime-probe.py')
spec = importlib.util.spec_from_file_location('background_probe', helper); probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
folder = Path('artifacts/product-gaps-20261004/autostart').resolve()
conversations = {p.name.removeprefix('workspace-') for p in folder.glob('workspace-*') if p.is_dir()}
db = sqlite3.connect(Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/agent-ai-schedules.sqlite')
endpoint = json.loads((probe.ROOT / 'background-endpoint.json').read_text())
count = 0
for row in db.execute('SELECT body FROM ai_schedules'):
    schedule = json.loads(row[0])
    if schedule['conversationId'] not in conversations or not schedule['name'].startswith('自带 Key · '): continue
    reply = probe.request(endpoint, 'ai_schedules_set_enabled', {'scheduleId': schedule['scheduleId'], 'enabled': False})
    assert reply['ok'], reply.get('error'); count += 1
    overview = probe.request(endpoint, 'ai_schedules_list', {'conversationId': schedule['conversationId']})
    assert overview['ok'], overview.get('error')
    for run in overview['result']['runs']:
        if run['scheduleId'] == schedule['scheduleId'] and run['state'] in ['queued', 'running', 'waiting_input', 'interrupted']:
            cancelled = probe.request(endpoint, 'ai_schedules_cancel_run', {'runId': run['runId']}); assert cancelled['ok'], cancelled.get('error')
print(json.dumps({'onlyAcceptanceWorkspacesMatched': True, 'disabledSchedules': count}))
