"""Remove only the named acceptance container and its private fixture files."""
from pathlib import Path
import argparse
import json
import subprocess
parser=argparse.ArgumentParser()
parser.add_argument('provider',choices=['mariadb','sqlserver','oracle'])
args=parser.parse_args()
root=(Path(__file__).resolve().parents[1]/'artifacts/product-gaps-20261004/database-providers').resolve()
private_file=root/f'{args.provider}-private-state.json'
state=json.loads(private_file.read_text(encoding='utf-8'))
name=state['container']
assert name.startswith(f'geod-agent-provider-{args.provider}-')
inspected=subprocess.run(['docker','inspect',name],capture_output=True,text=True)
if inspected.returncode==0:
    item=json.loads(inspected.stdout)[0]
    assert item['Config']['Labels'].get('dev.geod-agent.fixture')=='database-provider'
    subprocess.run(['docker','rm','--force','--volumes',name],check=True,stdout=subprocess.DEVNULL)
for relative in [f'{args.provider}-private-state.json',state['environmentFile'],'workspace/'+state['credentialFile']]:
    target=(root/relative).resolve()
    assert target.is_relative_to(root)
    if target.exists():
        assert target.is_file()
        target.unlink()
print(json.dumps({'provider':args.provider,'ownedContainerRemoved':True,'privateFilesRemoved':True}))
