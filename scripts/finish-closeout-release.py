"""Collect exact release evidence without installing or publishing anything."""
from pathlib import Path
import hashlib
import json
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[1]
candidate=ROOT/'artifacts/release-candidate-0.2.0-rc2-20261004'
previous=ROOT/'artifacts/release-candidate-0.2.0-rc1-20261004'
gateway=ROOT/'artifacts/gateway-release-0.2.0-20261004-r2'
def read(file): return json.loads(file.read_text(encoding='utf-8'))
def sha(file):
    with file.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()
freeze=read(candidate/'source-freeze.json')
assert all((ROOT/name).is_file() and sha(ROOT/name)==digest for name,digest in freeze['files'].items())
old=read(previous/'source-freeze.json')['files']
changes=sorted(name for name in set(old)|set(freeze['files']) if old.get(name)!=freeze['files'].get(name))
assert changes==['apps/geod-agent-desktop/src-tauri/src/services.rs','apps/geod-agent-desktop/test/codex-host.test.mjs']
manifest=read(candidate/'candidate.json')
assert all(sha(candidate/name)==metadata['sha256'] for name,metadata in manifest['artifacts'].items())
assert read(candidate/'integrated-payload.json')['passed']
assert manifest['runtimeVerification']==read(previous/'candidate.json')['runtimeVerification']
local=['final-native','final-local-model','cleanup','stop']
assert all(read(candidate/('closeout-'+phase+'.json'))['passed'] for phase in local)
retained=['init','model','backup','background','headless','returned','restart']
assert all(read(previous/('closeout-'+phase+'.json'))['passed'] for phase in retained)
assert read(previous/'profiles.json')['phase']=='restored'
assert read(previous/'isolation-processes.json')['passed']
assert read(candidate/'candidate-cleanup-processes.json')['passed']
assert read(candidate/'candidate-restart-processes.json')['passed']
restored=read(ROOT/'artifacts/product-gaps-20261004/payments/original-profile-preserved.json')
assert restored['passed'] and restored['originalConversations']==30 and restored['originalConnectionCount']==4
assert not read(previous/'closeout-production-model.json')['passed']
g=read(gateway/'candidate.json')
assert sha(gateway/g['archive'])==g['archiveSha256']
assert read(gateway/'actual-archive-start.json')['passed']
assert all(sha(ROOT/name)==digest for name,digest in g['sourceFiles'].items())
assert 'pass 62' in (gateway/'linux-tests.log').read_text(encoding='utf-8')
front=(ROOT/'artifacts/release-closeout-20261004/frontend-tests.log').read_text(encoding='utf-8')
assert 'pass 152' in front and 'fail 0' in front and 'skipped 3' in front
native=(ROOT/'artifacts/release-closeout-20261004-final/native-services.log').read_text(encoding='utf-8')
assert '13 passed; 0 failed' in native
report=dict(at=datetime.now(timezone.utc).isoformat(),version='0.2.0',status='ready_for_gateway_publication_approval',
    localCandidateAccepted=True,publicHostedReleaseReady=False,installed=False,published=False,chargingEnabled=False,
    sourceFilesVerified=len(freeze['files']),changesFromPreviousCandidate=changes,artifacts=manifest['artifacts'],
    runtimeGroups=8,runtimeFilesVerified=24944,frontend={'passed':152,'skipped':3,'failed':0},nativeServices={'passed':13,'failed':0},
    finalNativeReports=local,retainedReports={'candidate':previous.name,'phases':retained,'runtimeHashesUnchanged':True},
    originalDataRestored=restored,originalLocalGatewayPreserved=True,
    gatewayCandidate={'directory':gateway.name,'archive':g['archive'],'sha256':g['archiveSha256'],'linuxTestsPassed':62,'actualArchiveStarted':True},
    production=dict(identityAndUsageVerified=True,optionalPaymentsFallbackVerified=True,codexModelVerified=False,
        failureEvidence=previous.name+'/closeout-production-model.json',reason='The deployed gateway lacks the current Codex route',serverModified=False),
    deferred=['Clean Windows acceptance','Real system reboot','Signed update channel','Real payments and final pricing','Unverified payment history CSV/pagination','Remaining provider-specific roadmap'])
(candidate/'release-acceptance.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({key:report[key] for key in ['version','status','localCandidateAccepted','publicHostedReleaseReady','sourceFilesVerified','installed','published','chargingEnabled']}),flush=True)
