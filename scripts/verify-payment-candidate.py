"""Archive actual isolated payment checks; leave the authorized gateway intact."""
from pathlib import Path
import json
import subprocess
import hashlib
import datetime
import re
import psutil

repo = Path(__file__).resolve().parents[1]
service = repo/'services/geod-agent-model-gateway'
output = repo/'artifacts/product-gaps-20261004/payments'
output.mkdir(parents=True, exist_ok=True)
baseline = json.loads((repo/'artifacts/product-gaps-20261004/sponsored-months/gateway-state.json').read_text(encoding='utf-8'))
gateway = psutil.Process(baseline['originalGatewayPid'])
assert gateway.is_running() and abs(gateway.create_time()-baseline['originalGatewayCreatedAt']) < .01

report = {'passed':False, 'environment':'generated-key local protocol fixtures', 'realPayment':False,
          'realRefund':False, 'published':False, 'runningGatewayChanged':False, 'checks':[]}
commands = [
    ('gateway-regressions', ['node','--test','--test-reporter=tap','test/*.test.mjs']),
    ('dependency-audit', ['npm.cmd','audit','--json']),
]
for label, command in commands:
    result = subprocess.run(command, cwd=service, capture_output=True, encoding='utf-8', errors='strict')
    (output/(label+'.log')).write_text(result.stdout+result.stderr, encoding='utf-8')
    assert result.returncode == 0, f'{label} failed; inspect the retained log'
    if label == 'gateway-regressions':
        count=int(re.search(r'^# tests (\d+)$',result.stdout,re.M).group(1))
        assert count>=62 and '# fail 0' in result.stdout
        report['gatewayCases'] = count
        names=set(re.findall(r'^# Subtest: (.+)$',result.stdout,re.M))
        for field,file in [('paymentCases','payment-candidate.test.mjs'),('paymentHostCases','payment-host.test.mjs')]:
            expected=set(re.findall(r"^test\('([^']+)'",(service/'test'/file).read_text(encoding='utf-8'),re.M))
            assert expected and expected.issubset(names)
            report[field]=len(expected)
        report['actualSeparateProcessInterruptionVerified'] = True
    else:
        data = json.loads(result.stdout)
        assert data['metadata']['vulnerabilities']['total'] == 0
        report['knownDependencyVulnerabilities'] = 0
    report['checks'].append({'name':label, 'passed':True})

source = Path('G:/code/toolbox-platform-growth/services/platform-api/alipay-gateway.mjs')
lock = json.loads((service/'package-lock.json').read_text(encoding='utf-8'))
report['sourceAdapterSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
report['sdkVersion'] = lock['packages']['node_modules/alipay-sdk']['version']
report['networkDependencyVersion'] = lock['packages']['node_modules/urllib']['version']
report['files'] = {name:hashlib.sha256((service/name).read_bytes()).hexdigest() for name in
                  ['alipay-payment-candidate.mjs','payment-ledger-candidate.mjs','payment-http-candidate.mjs','payment-host-candidate.mjs','pricing-candidate.mjs','server.mjs',
                   'test/payment-candidate.test.mjs','test/payment-host.test.mjs','test/helpers/payment-fixture.mjs','test/helpers/payment-ledger-child.mjs','package-lock.json']}
gateway = psutil.Process(baseline['originalGatewayPid'])
assert gateway.is_running() and abs(gateway.create_time()-baseline['originalGatewayCreatedAt']) < .01
report['originalGatewayPreserved'] = True
report['passed'] = True
report['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(output/'acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key:value for key,value in report.items() if key not in ['files','sourceAdapterSha256']}, ensure_ascii=False))
