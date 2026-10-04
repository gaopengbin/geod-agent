"""Remove exactly the four owned TLS fixtures, then audit mutable app records."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess

root=(Path(__file__).resolve().parents[1]/'artifacts/product-gaps-20261004/database-tls').resolve()
providers=('mysql','mariadb','sqlserver','oracle')
states={provider:json.loads((root/'private'/provider/'state.json').read_text()) for provider in providers}
secrets=[]
for provider,state in states.items():
    folder=(root/'private'/provider).resolve()
    assert folder.is_relative_to(root) and folder.name==provider and not folder.is_symlink()
    secrets.extend(state[key].encode() for key in ('password','readerPassword'))
    secrets.extend(file.read_bytes() for file in folder.glob('*.key'))
    for file in folder.rglob('*'):
        assert not file.is_symlink() and file.resolve().is_relative_to(folder)
    name=state['container']
    assert name.startswith('geod-agent-tls-'+provider+'-')
    result=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
    if result.returncode==0:
        item=json.loads(result.stdout)[0]
        assert item['Config']['Labels'].get('dev.geod-agent.fixture')=='database-tls'
        assert item['Config']['Labels'].get('dev.geod-agent.fixture-id')==state['fixtureId']
        assert item['Image']==state['imageId']
        subprocess.run(['docker','rm','--force','--volumes',name],check=True,stdout=subprocess.DEVNULL)
    credential=(root/'workspace'/(provider+'-tls.json')).resolve()
    assert credential.is_relative_to(root) and credential.is_file()
    credential.unlink()
    shutil.rmtree(folder)
    print(json.dumps({'provider':provider,'ownedContainerRemoved':True,'privateMaterialRemoved':True}),flush=True)

# Only this exact earlier build backup may be removed, with the retained digest.
old_dll=root.parents[2]/'apps/geod-agent-desktop/src-tauri/target/debug/legacy-office-runtime/java/bin/ucrtbase.dll.build-previous'
if old_dll.is_file():
    assert old_dll.resolve().is_relative_to(root.parents[2])
    assert hashlib.sha256(old_dll.read_bytes()).hexdigest()=='2e5fb14b7bf8540278f3614a12f0226e56a7cc9e64b81cbd976c6fcf2f71cbfb'
    old_dll.unlink()

app=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'
checked,skipped,violations=0,[],[]
excluded={'node_modules','tmp-models','models','.git','cache','.cache'}
maximum=max(map(len,secrets))
for start in [root,app]:
    for directory,folders,files in os.walk(start,followlinks=False):
        folders[:]=[name for name in folders if name not in excluded and not (Path(directory)/name).is_symlink()]
        for name in files:
            file=Path(directory)/name
            if file.is_symlink():continue
            try:
                with file.open('rb') as stream:
                    tail=b''
                    while part:=stream.read(1024*1024):
                        data=tail+part
                        if any(secret in data for secret in secrets):
                            violations.append(str(file));break
                        tail=data[-maximum:]
                checked+=1
            except (OSError,PermissionError):skipped.append(str(file))
report={'passed':not violations,'filesChecked':checked,'scope':['current TLS evidence','mutable application records including SQLite, model transcripts and backups'],'excludedDirectories':sorted(excluded),'unreadableFiles':skipped,'violations':violations,'ownedContainersRemoved':True,'fixtureCredentialsAndKeysRemoved':True}
(root/'credential-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False),flush=True)
if violations:raise SystemExit(1)
