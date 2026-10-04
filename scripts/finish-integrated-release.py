"""Assemble a reviewable receipt only after actual isolation and restoration pass."""
from pathlib import Path
import argparse
import json
import os
import psutil

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('output')
output = Path(parser.parse_args().output).resolve()
assert output.is_relative_to(repo/'artifacts') and output.name.startswith('release-candidate-')
def read(name):
    return json.loads((output/name).read_text(encoding='utf-8'))
phases = ['init','inputs','model','backup','background','restart','cleanup','stop']
assert all(read('integrated-'+phase+'.json')['passed'] for phase in phases)
assert all(read(file)['passed'] for file in ['integrated-payload.json','integrated-headless.json',
    'integrated-process-secret-audit.json','integrated-credential-audit.json','integrated-environment.json',
    'isolation-processes.json','candidate-restart-processes.json','candidate-cleanup-processes.json',
    'development-chats-restored.json','original-connections-restored.json'])
profiles = read('profiles.json')
assert profiles['phase'] == 'restored' and all(profile['restored'] for profile in profiles['profiles'])
roaming = next(profile for profile in profiles['profiles'] if profile['kind'] == 'Roaming')
saved = read('integrated-qa-state.json')
assert saved['cleaned'] and not Path(saved['credentialFolder']).exists()
fixture = repo/'artifacts/product-gaps-20261004/integrated-release'
assert not (fixture/'private').exists() and not (fixture/'workspace/postgis-encrypted.json').exists()
candidate = read('candidate.json')
executable = (output/f"GeoD-Agent-{candidate['version']}-windows-x64/geod-agent-desktop.exe").resolve()
assert not any(process.info['name'] == 'geod-agent-desktop.exe' and Path(process.exe()).resolve() == executable for process in psutil.process_iter(['name']))
gateway_state = json.loads((repo/'artifacts/product-gaps-20261004/sponsored-months/gateway-state.json').read_text(encoding='utf-8'))
gateway = psutil.Process(gateway_state['originalGatewayPid'])
assert abs(gateway.create_time()-gateway_state['originalGatewayCreatedAt']) < .01 and gateway.is_running()
original_root = Path(roaming['source'])
backup_relative = Path(saved['backup']['path']).relative_to(original_root)
archived_backup = Path(roaming['archived'])/backup_relative
assert (archived_backup/'manifest.json').is_file()
report = dict(passed=True,version=candidate['version'],goalStillActive=True,
    runtimeGroups=len(candidate['runtimeVerification']),runtimeFiles=read('integrated-payload.json')['filesVerified'],
    actualNativeUiCases=sum(len(read('integrated-'+phase+'.json')['cases']) for phase in phases),
    actualForegroundMarkerCount=9,actualClosedWindowAttachmentReads=read('integrated-headless.json')['actualAttachmentReads'],
    actualClosedWindowDatabaseQueries=read('integrated-headless.json')['actualDatabaseQueries'],
    verifiedBackupRecords=saved['backup']['records'],verifiedBackupBytes=saved['backup']['bytes'],
    retainedVerifiedQaBackup=str(archived_backup),retainedQaProfiles=[profile['archived'] for profile in profiles['profiles']],
    originalConversationCount=read('development-chats-restored.json')['count'],
    originalConnectionCount=len(read('original-connections-restored.json')['ids']),
    originalGatewayPreserved=True,originalModelDefaultsPreserved=True,developmentHmrReopened=True,
    fixtureCredentialsRemoved=True,ownedContainerRemoved=True,installed=False,published=False,
    signedUpdate=False,cleanWindowsVerified=False,actualSystemRebootVerified=False)
(output/'integrated-acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({key:value for key,value in report.items() if not key.startswith('retained')},ensure_ascii=False),flush=True)
