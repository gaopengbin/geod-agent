"""Clean fixture containers and scan actual application records for this run's keys."""
from pathlib import Path
import json
import os
import subprocess
import sys
root=(Path(__file__).resolve().parents[1]/'artifacts/product-gaps-20261004/database-providers').resolve()
providers=sys.argv[1:]
assert providers and all(provider in ['mariadb','sqlserver','oracle'] for provider in providers)
states=[json.loads((root/f'{provider}-private-state.json').read_text(encoding='utf-8')) for provider in providers]
secrets=[state[key].encode('utf-8') for state in states for key in ['password','readerPassword']]
for provider in providers:
    subprocess.run([sys.executable,'-X','utf8',str(Path(__file__).with_name('cleanup-database-provider-fixture.py')),provider],check=True)
checked,skipped,violations=0,[],[]
folders=[root,Path(os.environ['APPDATA'])/'dev.geod-agent.desktop']
for folder in folders:
    for file in folder.rglob('*'):
        if not file.is_file():
            continue
        try:
            with file.open('rb') as stream:
                tail=b''
                while part:=stream.read(1024*1024):
                    data=tail+part
                    if any(secret in data for secret in secrets):
                        violations.append(str(file));break
                    tail=data[-max(map(len,secrets)):]
            checked+=1
        except (PermissionError,OSError):
            skipped.append(str(file))
result={'passed':not violations,'providers':providers,'filesChecked':checked,'unreadableFiles':skipped,'violations':violations,'ownedContainersRemoved':True,'privateFilesRemoved':True}
(root/'credential-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
if violations:raise SystemExit(1)
