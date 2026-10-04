"""Pin exact official wheels for the application-local document reader."""
from pathlib import Path
import json
import urllib.request

repo=Path(__file__).resolve().parents[1]
lock=repo/'vendor/document-runtime.lock.json'
base=json.loads(lock.read_text(encoding='utf-8'))
pins=[('msoffcrypto-tool','6.0.0','py3-none-any','MIT'),('cryptography','50.0.2','cp311-abi3-win_amd64','Apache-2.0 OR BSD-3-Clause'),('cffi','2.1.1','cp313-cp313-win_amd64','MIT'),('pycparser','3.0','py3-none-any','BSD-3-Clause'),('olefile','0.47','py2.py3-none-any','BSD-2-Clause')]
dependencies=[]
for name,version,tag,license in pins:
    url=f'https://pypi.org/pypi/{name}/{version}/json'
    with urllib.request.urlopen(url,timeout=30) as response: metadata=json.load(response)
    wheels=[file for file in metadata['urls'] if file['filename'].endswith('-'+tag+'.whl') and not file.get('yanked')]
    assert len(wheels)==1,(name,version)
    wheel=wheels[0]
    dependencies.append(dict(name=name,version=version,license=license,wheel=wheel['filename'],url=wheel['url'],sha256=wheel['digests']['sha256'],metadataSource=url))
base['dependencies']=dependencies
lock.write_text(json.dumps(base,indent=2)+'\n',encoding='utf-8')
print(json.dumps(dict(pinned=[dict(name=x['name'],version=x['version']) for x in dependencies])))
