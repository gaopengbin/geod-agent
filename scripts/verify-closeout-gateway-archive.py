from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import uuid
import tarfile
import posixpath
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('output')
parser.add_argument('--credit-history', action='store_true', help='Verify all four read-only history routes on the actual extracted archive.')
parser.add_argument('--payment-history', action='store_true', help='Also verify complete orders/refunds using local signed SDK fixtures and the actual extracted modules.')
args=parser.parse_args()
output=Path(args.output).resolve()
assert output.is_relative_to(root/'artifacts') and output.name.startswith('gateway-release-')
receipt=json.loads((output/'candidate.json').read_text(encoding='utf-8'))
archive=output/receipt['archive']
with archive.open('rb') as stream:
    assert hashlib.file_digest(stream,'sha256').hexdigest()==receipt['archiveSha256']
files,links,seen={},{},set()
with tarfile.open(archive,'r:gz') as tar:
    for member in tar:
        name=member.name
        assert name not in seen and not name.startswith('/') and '..' not in name.split('/')
        seen.add(name)
        assert name.split('/')[0] in {'services','packages'}
        if member.isfile():
            with tar.extractfile(member) as stream:
                files[name]=hashlib.file_digest(stream,'sha256').hexdigest()
        elif member.issym():
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name),member.linkname))
            assert not member.linkname.startswith('/') and target.split('/')[0] in {'services','packages'} and not target.startswith('../')
            links[name]=member.linkname
        else:
            assert member.isdir(), 'Unsupported archive member'
assert files==receipt['files'] and links==receipt['symlinks'], 'Archive inventory mismatch'
script=root/'scripts/verify-closeout-gateway-linux.mjs'
extra=[]
if args.payment_history:
    fixture=output/'staging/services/geod-agent-model-gateway/test/helpers/payment-fixture.mjs'
    expected=receipt['verificationInputs']['services/geod-agent-model-gateway/test/helpers/payment-fixture.mjs']
    with fixture.open('rb') as stream:
        assert hashlib.file_digest(stream,'sha256').hexdigest()==expected
    extra=['--mount',f'type=bind,source={fixture},target=/payment-fixture.mjs,readonly',
           '--mount',f'type=bind,source={root / "scripts/verify-payment-history-gateway-linux.mjs"},target=/verify-payment-history.mjs,readonly']
flags=(' --credit-history' if args.credit_history or args.payment_history else '')+(' --payment-history' if args.payment_history else '')
bootstrap='mkdir /tmp/gateway-rc && tar -xzf /candidate.tar.gz -C /tmp/gateway-rc'
if args.payment_history:
    bootstrap+=' && mkdir -p /tmp/gateway-rc/services/geod-agent-model-gateway/test/helpers && cp /payment-fixture.mjs /tmp/gateway-rc/services/geod-agent-model-gateway/test/helpers/payment-fixture.mjs'
verification_files=[script,root/'scripts/verify-closeout-gateway-archive.py']+([root/'scripts/verify-payment-history-gateway-linux.mjs'] if args.payment_history else [])
verification_inputs={file.relative_to(root).as_posix():hashlib.sha256(file.read_bytes()).hexdigest() for file in verification_files}
command=['docker','run','--rm','--init','--network','none','--mount',
    f'type=bind,source={archive},target=/candidate.tar.gz,readonly','--mount',
    f'type=bind,source={script},target=/verify.mjs,readonly',*extra,receipt['imageId'],
    'sh','-c',bootstrap+' && node /verify.mjs'+flags]
result=subprocess.run(command,text=True,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
attempt=output/('archive-acceptance-'+uuid.uuid4().hex[:16])
attempt.mkdir()
(attempt/'actual-archive-start.log').write_text(result.stdout+result.stderr,encoding='utf-8')
if result.returncode:
    (attempt/'result.json').write_text(json.dumps(dict(passed=False,exitCode=result.returncode,archiveSha256=receipt['archiveSha256'],verificationInputs=verification_inputs),indent=2),encoding='utf-8')
    raise SystemExit('Retained actual archive start failure; exit '+str(result.returncode))
report=json.loads(result.stdout.strip())
assert report['passed'] and report['actualArchiveStarted'] and not report['publicNetworkUsed']
if args.credit_history or args.payment_history:
    assert report['creditHistoryVerified'] and report['creditHistoryRestartVerified']
if args.payment_history:
    assert report['paymentHistory']['passed'] and report['paymentHistory']['restartVerified']
assert all(hashlib.sha256((root/name).read_bytes()).hexdigest()==digest for name,digest in verification_inputs.items()), 'Verifier changed during acceptance'
report.update(archiveSha256=receipt['archiveSha256'],published=False,productionModified=False)
report['verificationInputs']=verification_inputs
report['acceptanceDirectory']=attempt.name
report['archiveInventoryVerified']=True
report['archiveFileCount']=len(files)
report['archiveSymlinkCount']=len(links)
(attempt/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
(output/'actual-archive-start.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)
