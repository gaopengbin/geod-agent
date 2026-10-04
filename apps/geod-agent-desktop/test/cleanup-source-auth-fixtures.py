"""Remove only the declared synthetic records created by this acceptance test."""
import json, os, sqlite3, urllib.request, uuid
from pathlib import Path

def rpc(command, args=None):
    request = urllib.request.Request('http://127.0.0.1:1421/rpc', data=json.dumps({'command': command, 'args': args or {}}).encode(), headers={'content-type': 'application/json'})
    value = json.load(urllib.request.urlopen(request))
    if 'error' in value: raise RuntimeError(value['error'])
    return value['value']

assert rpc('jobs_active') == [], 'Do not clean while downloads are active'
sources = []
for descriptor in rpc('sources_list'):
    if not descriptor['id'].startswith('auth-fixture-'): continue
    source = rpc('sources_get', {'sourceId': descriptor['id']})
    endpoint = source['endpoint']
    assert endpoint['attribution'] == 'Controlled local synthetic pixels'
    assert endpoint['urlTemplate'].startswith(('http://127.0.0.1:15443/', 'http://127.0.0.1:15444/'))
    sources.append(descriptor['id'])
    # Remove the synthetic secret through the production credential lifecycle.
    rpc('sources_save', {'endpoint': endpoint, 'minZoom': descriptor['minZoom'], 'maxZoom': descriptor['maxZoom'], 'replaceExisting': True, 'credential': {'mode': None}})

database = Path(os.environ['APPDATA']) / 'dev.geod-agent.desktop/agent-tasks.sqlite'
connection = sqlite3.connect(database)
backup_path = Path(os.environ['TEMP']) / f'geod-auth-cleanup-{uuid.uuid4()}.sqlite'
with sqlite3.connect(backup_path) as backup: connection.backup(backup)
plans = [i for i,b in connection.execute('select plan_id,body from plans') if json.loads(b)['spec']['sourceId'] in sources]
schedules = [i for i,b in connection.execute('select schedule_id,body from schedules') if json.loads(b).get('templatePlanId') in plans or json.loads(b).get('name') == '认证图源定时执行验收']
jobs = [i for i,p in connection.execute('select job_id,plan_id from jobs') if p in plans]
with connection:
    for i in schedules:
        connection.execute('delete from schedule_runs where schedule_id=?', (i,))
        connection.execute('delete from schedules where schedule_id=?', (i,))
    for i in jobs:
        connection.execute('delete from job_events where job_id=?', (i,))
        connection.execute('delete from jobs where job_id=?', (i,))
    for i in plans:
        connection.execute('delete from approvals where plan_id=?', (i,))
        connection.execute('delete from plans where plan_id=?', (i,))
    for i in sources: connection.execute('delete from sources where source_id=?', (i,))
connection.close()
assert not any(item['id'] in sources for item in rpc('sources_list'))
print(json.dumps({'removedSyntheticSources': len(sources), 'removedSyntheticPlans': len(plans), 'removedSyntheticJobs': len(jobs), 'removedSyntheticSchedules': len(schedules), 'backup': str(backup_path)}, ensure_ascii=False))
