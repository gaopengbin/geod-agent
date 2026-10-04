"""Verify actual alternate ciphers, empty password, and integrity error distinction."""
from pathlib import Path
import hashlib,json,os,subprocess
from release_inventory import verify_runtime
repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/encrypted-documents'
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources'
passwords=json.loads((root/'private-passwords.json').read_text(encoding='utf-8'))
cases=[]
def run(name,password):
    value=subprocess.run([str(runtime/'gdal/python.exe'),'-I','-X','utf8',str(repo/'apps/geod-agent-desktop/src-tauri/src/attachment_worker.py'),str(root/'workspace'/name),'docx',str(runtime/'documents'),'--password-stdin'],input=json.dumps(dict(password=password)).encode('utf-8'),capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
    return json.loads(value.stdout)
for row in json.loads((root/'variant-fixtures.json').read_text(encoding='utf-8')):
    name=row['name'];assert hashlib.sha256((root/'workspace'/name).read_bytes()).hexdigest()==row['sha256']
    if name=='cfb-mode.docx':
        for password in [None,passwords[name]]: assert run(name,password).get('error')=='ATTACHMENT_PASSWORD_UNSUPPORTED'
    elif name=='damaged-integrity.docx':
        assert run(name,'INCORRECT_QA_VALUE').get('error')=='ATTACHMENT_PASSWORD_INCORRECT'
        assert run(name,passwords[name]).get('error')=='ATTACHMENT_DOCUMENT_INVALID'
    else:
        assert run(name,None).get('error')=='ATTACHMENT_PASSWORD_REQUIRED'
        assert run(name,'INCORRECT_QA_VALUE').get('error')=='ATTACHMENT_PASSWORD_INCORRECT'
        value=run(name,passwords[name]);assert value.get('ok') and value['wasEncrypted']
        assert json.loads((root/'fixtures.json').read_text(encoding='utf-8'))['markers']['word'] in value['text']
    cases.append(dict(name=name,passed=True));print(json.dumps(cases[-1]),flush=True)
checked=verify_runtime(runtime/'documents')
(root/'variant-result.json').write_text(json.dumps(dict(passed=True,cases=cases,**checked),indent=2),encoding='utf-8')
