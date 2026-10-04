from pathlib import Path
import argparse
import hashlib
import json
import subprocess
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('output')
output=Path(parser.parse_args().output).resolve()
assert output.is_relative_to(root/'artifacts') and output.name.startswith('gateway-release-')
receipt=json.loads((output/'candidate.json').read_text(encoding='utf-8'))
archive=output/receipt['archive']
with archive.open('rb') as stream:
    assert hashlib.file_digest(stream,'sha256').hexdigest()==receipt['archiveSha256']
script=root/'scripts/verify-closeout-gateway-linux.mjs'
command=['docker','run','--rm','--init','--network','none','--mount',
    f'type=bind,source={archive},target=/candidate.tar.gz,readonly','--mount',
    f'type=bind,source={script},target=/verify.mjs,readonly',receipt['imageId'],
    'sh','-c','mkdir /tmp/gateway-rc && tar -xzf /candidate.tar.gz -C /tmp/gateway-rc && node /verify.mjs']
result=subprocess.run(command,text=True,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
(output/'actual-archive-start.log').write_text(result.stdout+result.stderr,encoding='utf-8')
if result.returncode:
    raise SystemExit('Retained actual archive start failure; exit '+str(result.returncode))
report=json.loads(result.stdout.strip())
assert report['passed'] and report['actualArchiveStarted'] and not report['publicNetworkUsed']
report.update(archiveSha256=receipt['archiveSha256'],published=False,productionModified=False)
(output/'actual-archive-start.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report),flush=True)
