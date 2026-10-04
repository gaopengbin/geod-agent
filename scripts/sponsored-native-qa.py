"""Owned local sponsored protocol acceptance; never persist an upstream key."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener, ProxyHandler
import argparse, hashlib, json, os, secrets, socket, sqlite3, subprocess, sys, threading, time
import psutil

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'artifacts/product-gaps-20261004/sponsored-native'
STATE = ROOT / 'gateway-state.json'
FLAGS = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP

def write(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(file)

def owned(pid, created):
    process = psutil.Process(pid)
    if abs(process.create_time()-created) > .01:
        raise RuntimeError('Owned acceptance process identity changed')
    return process

def active():
    file = ROOT/'gateway.sqlite'
    if not file.exists(): return 0
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:
        return db.execute("SELECT COUNT(*) FROM model_generations WHERE state IN ('reserved','streaming')").fetchone()[0]

def serve():
    state = json.loads(STATE.read_text(encoding='utf-8'))
    key = os.environ['DEEPSEEK_API_KEY']
    wire_records, signatures = [], {}
    network = build_opener()
    class Gemini(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            if self.headers.get('x-goog-api-key') != key or self.headers.get('Authorization'):
                self.send_error(401);return
            try:
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                messages=[];pending=[];image_count=0;replayed=0
                if body.get('systemInstruction'): messages.append({'role':'system','content':'\n'.join(p['text'] for p in body['systemInstruction']['parts'])})
                for message in body['contents']:
                    content=[];calls=[];results=[]
                    for part in message['parts']:
                        if 'thoughtSignature' in part:
                            assert signatures[part['thoughtSignature']] == {k:v for k,v in part.items() if k!='thoughtSignature'}
                            replayed+=1
                        if 'text' in part and not part.get('thought'):content.append({'type':'text','text':part['text']})
                        if 'inlineData' in part:
                            media=part['inlineData'];content.append({'type':'image_url','image_url':{'url':f"data:{media['mimeType']};base64,{media['data']}"}});image_count+=1
                        if 'functionCall' in part:
                            call=part['functionCall'];call_id=call.get('id') or 'call_'+secrets.token_hex(12);pending.append((call['name'],call_id));calls.append({'id':call_id,'type':'function','function':{'name':call['name'],'arguments':json.dumps(call.get('args',{}),ensure_ascii=False)}})
                        if 'functionResponse' in part:
                            response=part['functionResponse'];index=next(i for i,(name,_) in enumerate(pending) if name==response['name']);_,call_id=pending.pop(index);results.append({'role':'tool','tool_call_id':response.get('id') or call_id,'content':json.dumps(response['response'],ensure_ascii=False)})
                    if content or calls:messages.append({'role':'assistant' if message['role']=='model' else 'user','content':content if image_count else ''.join(p.get('text','') for p in content),**({'tool_calls':calls} if calls else {})})
                    messages.extend(results)
                tools=[{'type':'function','function':{'name':t['name'],'description':t.get('description',''),'parameters':t['parametersJsonSchema']}} for group in body.get('tools',[]) for t in group['functionDeclarations']]
                upstream={'model':'deepseek-flash','messages':messages,'max_tokens':body['generationConfig']['maxOutputTokens'],'thinking':{'type':'disabled'},'stream':False,**({'tools':tools} if tools else {})}
                request=Request('https://api.deepseek.com/chat/completions',data=json.dumps(upstream,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
                with network.open(request,timeout=160) as response: actual=json.load(response)
                choice=actual['choices'][0];message=choice['message'];usage=actual['usage']
                wire_records.append({'protocol':'gemini','actualUpstream':'DeepSeek','upstreamId':actual['id'],'upstreamModel':actual['model'],'usage':usage,'images':image_count,'replayedSignatureBlocks':replayed,'tools':[c['function']['name'] for c in message.get('tool_calls',[])]})
                write(ROOT/'gemini-wire-evidence.json',{'officialGeminiProviderVerified':False,'records':wire_records})
                self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers();self.close_connection=True
                def event(value):self.wfile.write(('data: '+json.dumps(value,ensure_ascii=False)+'\r\n\r\n').encode());self.wfile.flush()
                if message.get('content'):event({'responseId':actual['id'],'modelVersion':actual['model'],'candidates':[{'index':0,'content':{'role':'model','parts':[{'text':message['content']}]}}]})
                for call in message.get('tool_calls',[]):
                    part={'functionCall':{'name':call['function']['name'],'args':json.loads(call['function']['arguments'])}};signature='qa-signature-'+secrets.token_hex(12);signatures[signature]=part
                    event({'responseId':actual['id'],'modelVersion':actual['model'],'candidates':[{'index':0,'content':{'role':'model','parts':[{**part,'thoughtSignature':signature}]}}]})
                event({'responseId':actual['id'],'modelVersion':actual['model'],'candidates':[{'index':0,'finishReason':'MAX_TOKENS' if choice.get('finish_reason')=='length' else 'STOP'}],'usageMetadata':{'promptTokenCount':usage['prompt_tokens'],'candidatesTokenCount':usage['completion_tokens'],'totalTokenCount':usage['total_tokens'],'cachedContentTokenCount':usage.get('prompt_cache_hit_tokens',0)}})
            except Exception as error:
                wire_records.append({'fixtureError':type(error).__name__});write(ROOT/'gemini-wire-evidence.json',{'officialGeminiProviderVerified':False,'records':wire_records})
                try:self.send_error(502,'Protocol acceptance fixture failed')
                except OSError:pass
    converter=ThreadingHTTPServer(('127.0.0.1',0),Gemini);threading.Thread(target=converter.serve_forever,daemon=True).start()
    config=json.loads((ROOT/'sponsors.json').read_text(encoding='utf-8'))
    for provider in config:
        if provider['protocol']=='gemini':provider['baseUrl']=f'http://127.0.0.1:{converter.server_port}/gemini'
    write(ROOT/'sponsors.json',config)
    env=dict(os.environ,GEOD_LOCAL_DESKTOP_TEST='1',GEOD_LOCAL_GATEWAY_PORT=str(state['port']),GEOD_LOCAL_GATEWAY_DB_PATH=str(ROOT/'gateway.sqlite'),GEOD_AGENT_SPONSORS_JSON=json.dumps(config))
    with (ROOT/'gateway.log').open('ab') as log:
        child=subprocess.Popen([os.environ['GEOD_QA_GATEWAY_NODE'],str(REPO/'services/geod-agent-model-gateway/dev/local-desktop-gateway.mjs')],cwd=REPO,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=FLAGS)
    state.update(gatewayPid=child.pid,gatewayCreatedAt=psutil.Process(child.pid).create_time(),converterPort=converter.server_port)
    direct=build_opener(ProxyHandler({}))
    try:
        for _ in range(100):
            if child.poll() is not None:raise RuntimeError('Acceptance gateway failed to start')
            try:
                with direct.open(f"http://127.0.0.1:{state['port']}/health",timeout=1) as response:
                    if response.status==200:break
            except OSError:time.sleep(.2)
        else:raise RuntimeError('Acceptance gateway readiness timeout')
        state.update(ready=True,controllerPid=os.getpid(),controllerCreatedAt=psutil.Process().create_time());write(STATE,state)
        while not (ROOT/'stop.json').exists():
            if child.poll() is not None:raise RuntimeError('Acceptance gateway exited unexpectedly')
            if (ROOT/'clear.json').exists() and not state.get('catalogueCleared'):
                if active():raise RuntimeError('Refusing to clear active sponsored routes')
                child.terminate();child.wait(timeout=10);env['GEOD_AGENT_SPONSORS_JSON']='[]'
                with (ROOT/'gateway.log').open('ab') as log:child=subprocess.Popen([os.environ['GEOD_QA_GATEWAY_NODE'],str(REPO/'services/geod-agent-model-gateway/dev/local-desktop-gateway.mjs')],cwd=REPO,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=FLAGS)
                for _ in range(100):
                    try:
                        with direct.open(f"http://127.0.0.1:{state['port']}/health",timeout=1) as response:
                            if response.status==200:break
                    except OSError:time.sleep(.2)
                else:raise RuntimeError('Cleared acceptance gateway readiness timeout')
                state.update(catalogueCleared=True,gatewayPid=child.pid,gatewayCreatedAt=psutil.Process(child.pid).create_time());write(STATE,state)
            time.sleep(.2)
        if active():raise RuntimeError('Refusing to stop a gateway with an active generation')
    finally:
        if child.poll() is None and not active():child.terminate();child.wait(timeout=10)
        converter.shutdown();converter.server_close()
        for file in [ROOT/'gateway.log',ROOT/'controller.log']:
            if file.exists():file.write_text(file.read_text(encoding='utf-8',errors='replace').replace(key,'[redacted]').replace(os.environ['GEOD_LOCAL_GATEWAY_SECRET'],'[redacted]'),encoding='utf-8')
        state.update(ready=False,stopped=True);write(STATE,state)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['start','serve','desktop','reload','clear','stop','ledger','audit']);parser.add_argument('--resume-start',action='store_true');args=parser.parse_args();ROOT.mkdir(parents=True,exist_ok=True)
    if args.mode=='serve':serve();return
    if args.mode=='start':
        if STATE.exists():
            previous=json.loads(STATE.read_text(encoding='utf-8'))
            if not args.resume_start or not previous.get('stopped') or active() or (ROOT/'qa-state.json').exists():raise RuntimeError('Existing acceptance state requires inspection before reuse')
            write(ROOT/'initial-failed-gateway-state.json',previous)
        pid=int((Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/dev-logs/local-gateway.pid').read_text().strip());original=psutil.Process(pid);command=original.cmdline();assert any(p.endswith('local-desktop-gateway.mjs') for p in command)
        key=original.environ().get('DEEPSEEK_API_KEY');assert key,'Existing authorized project test key unavailable'
        with socket.socket() as listener:listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
        model=dict(id='deepseek-flash',name='DeepSeek Flash',contextWindow=128000,maxOutputTokens=4096,inputModalities=['text','image'],thinking='disabled')
        common=dict(apiKeyEnv='DEEPSEEK_API_KEY',allowedUsers=['local-desktop-test'],models=[model],quotaMode='observe')
        configs=[dict(common,id='native-'+protocol.lower(),name='赞助接口验收 · '+protocol,protocol=protocol,baseUrl='https://api.deepseek.com/anthropic' if protocol=='anthropic' else 'https://api.deepseek.com',description='本机真实模型验收') for protocol in ['chatCompletions','responses','anthropic','gemini']]
        configs.extend([dict(common,id='activity-future',name='未来赞助活动验收',protocol='chatCompletions',baseUrl='https://api.deepseek.com',startsAt='2099-10-04T00:00:00Z'),dict(common,id='activity-ended',name='已结束赞助活动验收',protocol='responses',baseUrl='https://api.deepseek.com',endsAt='2020-10-04T00:00:00Z')])
        write(ROOT/'sponsors.json',configs);write(STATE,dict(port=port,ready=False,stopped=False,originalGatewayPid=pid,originalGatewayCreatedAt=original.create_time()))
        if not (ROOT/'expected.json').exists():
            from PIL import Image,ImageDraw,ImageFont
            image=Image.new('RGB',(1000,650),'white');draw=ImageDraw.Draw(image);nonce=str(secrets.randbelow(900000)+100000);font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',100);draw.text((230,75),nonce,font=font,fill='black');draw.ellipse((80,290,280,490),fill='#d22d2d');draw.polygon([(400,490),(500,290),(600,490)],fill='#2466d8');draw.rectangle((720,290,920,490),fill='#168344');image.save(ROOT/'visual-input.png')
            workspace=ROOT/'workspace';workspace.mkdir();name='SPONSORED_'+secrets.token_hex(14)+'.geojson';(workspace/name).write_text(json.dumps({'type':'FeatureCollection','features':[]}),encoding='utf-8');write(ROOT/'expected.json',dict(nonce=nonce,workspace=str(workspace),marker=name,image=str(ROOT/'visual-input.png')))
        env=dict(os.environ,DEEPSEEK_API_KEY=key,GEOD_LOCAL_GATEWAY_SECRET=secrets.token_hex(32),GEOD_QA_GATEWAY_NODE=command[0])
        with (ROOT/'controller.log').open('ab') as log:process=subprocess.Popen([sys.executable,'-X','utf8',str(Path(__file__).resolve()),'serve'],cwd=REPO,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=FLAGS)
        for _ in range(150):
            state=json.loads(STATE.read_text(encoding='utf-8'))
            if state['ready']:print(json.dumps(dict(ready=True,port=port,originalGatewayPreserved=original.is_running())));return
            if process.poll() is not None:raise RuntimeError('Acceptance controller failed; inspect redacted log')
            time.sleep(.2)
        raise RuntimeError('Acceptance controller readiness timeout')
    state=json.loads(STATE.read_text(encoding='utf-8'))
    if args.mode=='desktop':
        assert state['ready'];env=dict(os.environ,GEOD_AGENT_DEV_GATEWAY_ORIGIN=f"http://127.0.0.1:{state['port']}");env.pop('DEEPSEEK_API_KEY',None);env.pop('GEOD_LOCAL_GATEWAY_SECRET',None);subprocess.run([sys.executable,'-X','utf8','scripts/start-codex-dev.py'],cwd=REPO,env=env,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
    elif args.mode=='reload':
        process=owned(state['controllerPid'],state['controllerCreatedAt']);assert not active();env=process.environ();write(ROOT/'stop.json',{'stop':True});process.wait(timeout=15);(ROOT/'stop.json').unlink()
        with (ROOT/'controller.log').open('ab') as log:child=subprocess.Popen([sys.executable,'-X','utf8',str(Path(__file__).resolve()),'serve'],cwd=REPO,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=FLAGS)
        for _ in range(150):
            current=json.loads(STATE.read_text(encoding='utf-8'))
            if current.get('ready') and current.get('controllerPid')==child.pid:print(json.dumps({'reloaded':True}));return
            if child.poll() is not None:raise RuntimeError('Owned acceptance controller reload failed')
            time.sleep(.2)
        raise RuntimeError('Owned acceptance controller reload readiness timeout')
    elif args.mode=='clear':
        owned(state['controllerPid'],state['controllerCreatedAt']);assert not active();write(ROOT/'clear.json',{'clear':True})
        for _ in range(150):
            if json.loads(STATE.read_text(encoding='utf-8')).get('catalogueCleared'):print(json.dumps({'cleared':True}));return
            time.sleep(.2)
        raise RuntimeError('Sponsor catalogue clear acknowledgment timeout')
    elif args.mode=='stop':
        process=owned(state['controllerPid'],state['controllerCreatedAt']);assert not active();write(ROOT/'stop.json',{'stop':True});process.wait(timeout=15);print(json.dumps({'stopped':True,'originalGatewayPreserved':owned(state['originalGatewayPid'],state['originalGatewayCreatedAt']).is_running()}))
    elif args.mode=='ledger':
        with sqlite3.connect((ROOT/'gateway.sqlite').as_uri()+'?mode=ro',uri=True) as db:db.row_factory=sqlite3.Row;rows=[dict(row) for row in db.execute('SELECT generation_id,conversation_id,model,state,input_tokens,output_tokens,upstream_request_id,upstream_model,funding_scope,sponsor_id,sponsor_revision,error_code FROM model_generations ORDER BY created_at')]
        write(ROOT/'actual-server-ledger.json',{'rows':rows});print(json.dumps({'generations':len(rows),'actualTokens':sum((r['input_tokens'] or 0)+(r['output_tokens'] or 0) for r in rows),'active':active()}))
    elif args.mode=='audit':
        controller=owned(state['controllerPid'],state['controllerCreatedAt']);key=controller.environ()['DEEPSEEK_API_KEY'].encode();violations=[];checked=0
        roots=[ROOT,Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/ai-channels']
        qa_file=ROOT/'qa-state.json'
        if qa_file.exists():
            qa=json.loads(qa_file.read_text(encoding='utf-8'))
            if qa.get('backup'):roots.append(Path(qa['backup']['path']))
            account='account-'+hashlib.sha256(qa['userId'].encode()).hexdigest()
            for conversation in qa['qa']:roots.append(Path(os.environ['APPDATA'])/'dev.geod-agent.desktop/codex-runtime'/account/('conversation-'+hashlib.sha256(conversation['id'].encode()).hexdigest()[:16]))
        for directory in roots:
            if not directory.exists():continue
            for file in directory.rglob('*'):
                if file.is_file() and file.stat().st_size<64*1024*1024:
                    checked+=1
                    if key in file.read_bytes():violations.append(str(file))
        desktop_key=any(key.decode() in process.environ().values() for process in psutil.process_iter(['name']) if process.info['name']=='geod-agent-desktop.exe')
        report={'passed':not violations and not desktop_key,'filesChecked':checked,'plaintextCredentialFiles':violations,'desktopProviderKeyPresent':desktop_key};write(ROOT/'credential-audit.json',report);print(json.dumps(report));assert report['passed']

if __name__=='__main__':main()
