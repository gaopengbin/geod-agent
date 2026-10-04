"""Actual bundled CPython/private-JRE reading with local password stdin."""
from pathlib import Path
import hashlib,json,os,subprocess,time
from release_inventory import verify_runtime

repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/encrypted-documents'
fixtures=json.loads((root/'fixtures.json').read_text(encoding='utf-8'))
passwords=json.loads((root/'private-passwords.json').read_text(encoding='utf-8'))
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources'
worker=repo/'apps/geod-agent-desktop/src-tauri/src/attachment_worker.py'
environment={key:value for key,value in os.environ.items() if key.upper() in {'SYSTEMROOT','WINDIR','TEMP','TMP'}}
environment['PATH']=str(Path(os.environ['SYSTEMROOT'])/'System32')
cases=[]
def execute(name,password,raw=None):
    file=root/'workspace'/name;extension=file.suffix[1:]
    if extension in ['doc','xls','ppt']:
        office=runtime/'legacy-office'
        command=[str(office/'java/bin/java.exe'),'-Xms16m','-Xmx384m','-Djava.awt.headless=true','-Dfile.encoding=UTF-8','-cp',str(office)+os.pathsep+str(office/'tika-app-3.3.2.jar'),'GeodOfficeReader',str(file),extension,'--password-stdin']
    else:
        command=[str(runtime/'gdal/python.exe'),'-I','-X','utf8',str(worker),str(file),extension,str(runtime/'documents'),str(runtime/'ocr'),'--password-stdin']
    start=time.monotonic()
    output=subprocess.run(command,input=raw if raw is not None else json.dumps({'password':password},ensure_ascii=False).encode('utf-8'),env=environment,capture_output=True,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
    try: value=json.loads(output.stdout)
    except Exception: raise AssertionError('Parser did not return JSON: '+name+'; '+output.stderr.decode('utf-8',errors='replace')[:1000])
    return value,output.returncode,round(time.monotonic()-start,3)
def record(name,**detail):
    cases.append(dict(name=name,passed=True,**detail))
    (root/'parser-result.json').write_text(json.dumps(dict(passed=False,cases=cases),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(name=name,passed=True),ensure_ascii=False),flush=True)
try:
    for resource in ['documents','legacy-office']:
        record('Complete pinned '+resource+' inventory',**verify_runtime(runtime/resource))
    for name,metadata in fixtures['files'].items():
        assert hashlib.sha256(Path(metadata['path']).read_bytes()).hexdigest()==metadata['sha256']
        if name!='owner-only.pdf':
            for password,expected in [(None,'ATTACHMENT_PASSWORD_REQUIRED'),('INCORRECT_QA_VALUE','ATTACHMENT_PASSWORD_INCORRECT')]:
                value,status,seconds=execute(name,password)
                assert value.get('error')==expected and status==1,(name,expected,value)
                record(name+' '+expected,seconds=seconds)
        value,status,seconds=execute(name,None if name=='owner-only.pdf' else passwords[name])
        assert value.get('ok') is True and status==0,(name,value)
        key='pdf' if name.startswith('pdf-') or name=='owner-only.pdf' else name.rsplit('.',1)[-1]
        key={'docx':'word','xlsx':'sheet','pptx':'slides'}.get(key,key)
        marker=fixtures['scanMarker'] if name=='scan-aes256.pdf' else fixtures['markers'][key]
        assert marker in value['text'],name
        if name.endswith('pptx'): assert fixtures['markers']['notes'] in value['text']
        if name.endswith('xls') or name.endswith('xlsx'): assert 'FORMULAS_NOT_RECALCULATED' in value['warnings']
        if name=='binary.xls': assert 'A2: 3 [formula: 8+9]' in value['text']
        if name=='scan-aes256.pdf': assert value['ocrPages']==[1] and value['ocrEngine']
        if name.startswith('pdf-'): assert value['units']==2 and value['wasEncrypted'] is True
        (root/(name+'.parsed.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
        record(name+' actual decrypted content',seconds=seconds,characters=len(value['text']),units=value['units'],warnings=value['warnings'])
    for name in ['agile.docx','binary.xls','pdf-AES-256.pdf']:
        for request in [b'{"password":42}',json.dumps({'password':'x'*4097}).encode(),b'x'*32769]:
            value,status,_=execute(name,None,request)
            assert value.get('error')=='ATTACHMENT_PASSWORD_INPUT' and status==1,(name,value)
        record(name+' invalid password input rejected')
    (root/'parser-result.json').write_text(json.dumps(dict(passed=True,cases=cases),ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(passed=True,cases=len(cases)),ensure_ascii=False),flush=True)
except Exception as failure:
    (root/'parser-failure.json').write_text(json.dumps(dict(passed=False,error=str(failure),cases=cases),ensure_ascii=False,indent=2),encoding='utf-8');raise
