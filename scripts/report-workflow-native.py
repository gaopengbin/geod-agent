"""Verify the owned database/COG QA artifacts and summarize recovery evidence."""
from pathlib import Path
import hashlib
import json
import os
import subprocess

repo = Path(__file__).resolve().parents[1]
root = repo / 'artifacts/workflow-native-20261018'
load = lambda name: json.loads((root / name).read_text(encoding='utf-8'))
before, after, turn, state = (load(name) for name in
    ('snapshot-interrupted.json', 'snapshot-final.json', 'turn-current.json', 'state.json'))
assert before['conversationId'] == after['conversationId'] == state['conversationId']
assert turn['done'] and not turn['error'] and turn['result']['status'] == 'completed'
old = {s['id']: s for s in before['workflow']['steps']}
new = {s['id']: s for s in after['workflow']['steps']}
assert all(s['state'] == 'completed' for s in new.values())
assert old['convert_cog_demo01']['state'] == 'failed'
assert old['convert_cog_demo01']['lastError']['error'] == 'QA_INTERRUPTED_BEFORE_CONVERSION'
assert all(new[k]['attempts'] == s['attempts'] and new[k]['receipt'] == s['receipt']
           for k, s in old.items() if not k.startswith('convert_cog_'))
assert not turn['questions']
assert not [t for t in turn['tools'] if t['name'] in
            ('jobs_start', 'plan_imagery', 'plan_imagery_batch', 'ask_user',
             'data_input_read', 'data_layer_inspect', 'data_connection_connect')]
for asset in before['files']:
    assert asset in after['files']
    assert hashlib.sha256((Path(state['workspace']) / asset['path']).read_bytes()).hexdigest() == asset['sha256']

# Run the exact read-only verifier using the same installed native GIS components.
profile = Path(after['home']).parent.parent.parent
catalogue = json.loads((repo / 'vendor/gis-components.json').read_text())['components']
paths = []
for component in ('gis-common', 'gis-raster'):
    package = next(p for p in catalogue if p['id'] == component)
    folder = profile / 'gis-components' / f"{component}-{package['version']}-{package['sha256'][:16]}"
    assert folder.is_dir()
    paths.append(str(folder))
python = repo / 'apps/geod-agent-desktop/src-tauri/resources/python/python.exe'
assert python.is_file()
source = 'import sys; sys.dont_write_bytecode=True; sys.path[:0]=' + json.dumps(paths) + '\n'
source += (repo / 'apps/geod-agent-desktop/src-tauri/src/workflow_verify.py').read_text(encoding='utf-8')
env = {k: os.environ[k] for k in ('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE') if k in os.environ}
env['PATH'] = str(Path(os.environ['SYSTEMROOT']) / 'System32')

def verify(check):
    result = subprocess.run([str(python), '-X', 'utf8', '-I', '-c', source],
                            input=json.dumps(check), capture_output=True, text=True,
                            encoding='utf-8', cwd=state['workspace'], env=env,
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=180, check=True)
    return json.loads(result.stdout)

positive, negative = [], []
for project in ('01', '02'):
    check = dict(kind='raster', path=f'delivery/DEMO-{project}.tif', crs='EPSG:4326',
                 layout='COG', compression='lzw', overviews=[2, 4, 8])
    verified = verify(check)
    assert verified['verified'], verified
    assert all(c['verified'] for c in new[f'convert_cog_demo{project}']['checks'])
    positive.append(verified)
for key, incorrect in (('crs', 'EPSG:3857'), ('layout', 'GTiff'), ('overviews', [2, 4])):
    result = verify({**check, key: incorrect})
    assert not result['verified'] and key in result['failedChecks']
    negative.append(dict(condition=key, expected=incorrect, result=result))

downloads = []
for step_id in ('start_download_demo01', 'start_download_demo02'):
    receipt = after['receipts'][step_id]
    assert receipt['backgroundResult']['verified']
    assert receipt['jobId'] == before['receipts'][step_id]['jobId']
    downloads.append(dict(stepId=step_id, jobId=receipt['jobId'], approvalId=receipt.get('approvalId'),
                          attempts=new[step_id]['attempts'], verified=True))
generations = {g['generationId']: g for g in turn['generations']}
report = dict(
    status='passed', conversationId=state['conversationId'], corePreserved=True, fixedIterationCap=False,
    scenario='Actual PostGIS read, two Esri Z18 downloads and native COG conversions with sponsored GPT-6 Luna',
    interruption='Known failure injected immediately before first COG dispatch, followed by a full desktop restart',
    recovery=dict(allStepsVerified=len(new), reusedUpstreamSteps=len(old)-2,
                  extraDownloads=0, extraPlans=0, repeatedQuestions=0, repeatedDatabaseReads=0,
                  originalFilesUnchanged=True, downloads=downloads,
                  conversionAttempts={k: s['attempts'] for k, s in new.items() if k.startswith('convert_cog_')}),
    artifacts=positive, negativeAcceptanceChecks=negative,
    measuredRecoveryUsage=dict(model=state['modelId'], billingScope='sponsored',
                              requests=len(generations), inputTokens=sum(g.get('inputTokens') or 0 for g in generations.values()),
                              outputTokens=sum(g.get('outputTokens') or 0 for g in generations.values()),
                              scope='Only the final recovery after the simulated conversion interruption'),
    developmentNotes=[
        'Earlier integration attempts exposed a dormant Docker port binding and acceptance harness wrapper mismatches.',
        'An append regression caused by JSON property order was fixed and tested. Only this QA workflow was restored from its prior verified snapshot before the final interruption/restart acceptance.',
        'The final interruption/restart/recovery used persisted runtime receipts without manual checkpoint changes.',
        'This is native development runtime acceptance, not a recording or an installed release UI test.',
    ])
(root / 'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: report[k] for k in ('status', 'recovery', 'artifacts', 'measuredRecoveryUsage')}, ensure_ascii=False, indent=2))
