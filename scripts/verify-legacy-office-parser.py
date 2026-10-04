"""Actual private JRE parsing, binary validation, cached values and slide order."""
from pathlib import Path
import hashlib,json,os,subprocess,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from release_inventory import verify_runtime

repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/legacy-office'
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources/legacy-office'
fixture=json.loads((root/'fixtures.json').read_text(encoding='utf-8'))
cases=[];requests=[]
class Listener(BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path);self.send_response(200);self.end_headers();self.wfile.write(b'Never read this network content')
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',43181),Listener)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    checked=verify_runtime(runtime)
    environment={key:value for key,value in os.environ.items() if key.upper() in {'SYSTEMROOT','WINDIR','TEMP','TMP'}}
    environment['PATH']=str(Path(os.environ['SYSTEMROOT'])/'System32')
    command=[str(runtime/'java/bin/java.exe'),'-Xms16m','-Xmx384m','-Djava.awt.headless=true','-Dfile.encoding=UTF-8','-cp',str(runtime)+os.pathsep+str(runtime/'tika-app-3.3.2.jar'),'GeodOfficeReader']
    expected_errors={'encrypted.xls':'ATTACHMENT_PASSWORD_REQUIRED',**{name:'ATTACHMENT_DOCUMENT_INVALID' for name in ['damaged.doc','damaged.xls','damaged.ppt','renamed-workbook.doc']}}
    for name,file in fixture['files'].items():
        assert hashlib.sha256(Path(file['path']).read_bytes()).hexdigest()==file['sha256']
        start=time.monotonic();result=subprocess.run([*command,file['path'],Path(name).suffix[1:]],env=environment,capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        (root/(name+'.stdout.json')).write_bytes(result.stdout);(root/(name+'.stderr.txt')).write_bytes(result.stderr)
        actual=json.loads(result.stdout.decode('utf-8'))
        if name in expected_errors:
            assert not actual['ok'] and result.returncode==1 and actual['error']==expected_errors[name],(name,actual)
        else:
            assert result.returncode==0 and actual['ok'] and not actual['truncated']
            marker=fixture['markers'][{'beijing-brief.doc':'en','北京旧版说明.doc':'zh','beijing-table.xls':'xls','beijing-slides.ppt':'ppt'}[name]]
            assert marker in actual['text'] and ('Beijing' in actual['text'] or '北京' in actual['text'])
            if name=='beijing-table.xls':
                assert actual['units']==2 and actual['sheets']==['Coordinates','第二工作表']
                assert 'B9: 3 [formula: 8+9]' in actual['text'],'Formula was recalculated or saved cache lost'
                assert 'FORMULAS_NOT_RECALCULATED' in actual['warnings']
                assert actual['text'].index('Coordinates')<actual['text'].index('第二工作表')
            if name=='beijing-slides.ppt':
                assert actual['units']==2
                assert actual['text'].index('REORDERED_FIRST_SLIDE')<actual['text'].index('ORIGINAL_FIRST_SLIDE')
        cases.append({'name':name,'passed':True,'seconds':round(time.monotonic()-start,3),'originalSha256':file['sha256'],'characters':len(actual.get('text',''))})
        print(json.dumps(cases[-1],ensure_ascii=False),flush=True)
    assert not requests,'A saved workbook hyperlink was unexpectedly fetched'
    cases.append({'name':'All pinned runtime files verified; system-only PATH and saved external hyperlink was not fetched','passed':True,**checked})
    (root/'parser-result.json').write_text(json.dumps({'passed':True,'cases':cases,'networkRequests':requests},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
except Exception as failure:
    (root/'parser-failure.json').write_text(json.dumps({'passed':False,'error':str(failure),'cases':cases},ensure_ascii=False,indent=2)+'\n',encoding='utf-8');raise
finally:server.shutdown();server.server_close()
