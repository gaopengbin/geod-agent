/** Actual native TLS, private-CA and client-certificate database acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const provider=process.argv[2];assert(['mysql','mariadb','sqlserver','oracle'].includes(provider));
const root=path.resolve('artifacts/product-gaps-20261004/database-tls'),workspace=path.join(root,'workspace');
const fixture=JSON.parse(fs.readFileSync(path.join(root,`${provider}-fixture.json`),'utf8'));
const privateRoot=path.join(root,'private',provider),privateState=JSON.parse(fs.readFileSync(path.join(privateRoot,'state.json'),'utf8'));
const draft=JSON.parse(fs.readFileSync(path.join(workspace,fixture.credentialFile),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let attempt=0;attempt<60;attempt++){
  page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
  if(page)break;
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert(page,'The development desktop did not expose its UI');await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const stateFile=path.join(root,'qa-state.json'),reportFile=path.join(root,`${provider}-native-result.json`);
const secrets=[privateState.password,privateState.readerPassword,...['client','wrong-client','server','ca','wrong-ca'].map(name=>fs.readFileSync(path.join(privateRoot,`${name}.key`),'utf8'))];
function write(name,value){const text=JSON.stringify(value,null,2);assert(secrets.every(secret=>!text.includes(secret)),'Private material entered public evidence');fs.writeFileSync(path.join(root,name),text);}
const report={provider,passed:false,cases:[]};if(fs.existsSync(reportFile))fs.copyFileSync(reportFile,path.join(root,`${provider}-native-attempt-${Date.now()}.json`));
const record=(name,detail={})=>{report.cases.push({name,passed:true,...detail});write(`${provider}-native-result.json`,report);console.log(JSON.stringify({name,passed:true}));};
const saved=new Set();let qa;
const read=connectionId=>rpc('sql_query',{connectionId,sql:`SELECT city,marker FROM ${fixture.table}`});
const connect=async(overrides={})=>{const result=await rpc('sql_connection_save',{conversationId:qa.conversationId,draft:{...draft,...overrides}});if(result.connection)saved.add(result.connection.id);return result;};
const mustFail=async(overrides,code)=>{const result=await connect(overrides);assert(!result.connection,'Invalid TLS unexpectedly connected');assert(result.error,'TLS did not report its failure');if(code)assert.equal(result.error.code,code);return result.error;};
try{
  if(fs.existsSync(stateFile))qa=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  else{
    const original=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]'),language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight};});
    write('original-conversations.json',original);qa={conversationId:randomUUID(),originalActive:original.active,baseline:(await rpc('sql_connections_list')).connections.map(connection=>connection.id),owned:[],schedules:[],originalChatCount:original.chats.length};
    await rpc('workspace_set',{conversationId:qa.conversationId,directory:workspace,permission:'fullAccess'});write('qa-state.json',qa);
  }
  const valid=await rpc('sql_connection_connect',{conversationId:qa.conversationId,request:{credentialFile:fixture.credentialFile}});assert(!valid.error,valid.error?.code);saved.add(valid.connection.id);const rows=(await read(valid.connection.id)).result.statements[0].rows;
  assert(JSON.stringify(rows).includes(fixture.marker));assert(JSON.stringify(rows).includes('北京'));
  assert.equal(valid.connection.customCa,true);assert.equal(valid.connection.clientCertificate,false);
  record('Actual private CA, verified hostname and native MCP query',{connection:valid.connection,mcp:valid.mcp,rows});
  const tlsSql=provider==='sqlserver'?null:provider==='oracle'?"SELECT SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') AS PROTOCOL FROM DUAL":"SHOW SESSION STATUS LIKE 'Ssl_cipher'";
  const cipher=tlsSql?(await rpc('sql_query',{connectionId:valid.connection.id,sql:tlsSql})).result:null;
  if(cipher){assert(cipher.statements[0].rows.some(row=>Object.values(row).some(value=>provider==='oracle'?String(value).toLowerCase()==='tcps':String(value).startsWith('TLS_'))));record('Database reports negotiated TLS transport',{cipher});}
  const wrongCa=await mustFail({sslRootCert:fs.readFileSync(path.join(privateRoot,'wrong-ca.pem'),'utf8')},'INPUT_TLS_FAILED');
  const missingCa=await mustFail({sslRootCert:undefined},'INPUT_TLS_FAILED');
  record('Wrong and missing private CA are rejected',{wrongCa,missingCa});
  const wrongHost=await mustFail({host:'127.0.0.1'},'INPUT_TLS_FAILED');record('Verified hostname rejects a reachable IP absent from the certificate',{error:wrongHost});
  if(provider!=='sqlserver'){
    const chainOnly=await connect({host:'127.0.0.1',sslMode:'verify-ca'});assert(!chainOnly.error,chainOnly.error?.code);assert(JSON.stringify(await read(chainOnly.connection.id)).includes(fixture.marker));
    record('Chain verification can be selected without hostname verification',{connection:chainOnly.connection});
  }
  const encrypted=await connect({host:'127.0.0.1',sslMode:'require'});assert(!encrypted.error,encrypted.error?.code);assert(JSON.stringify(await read(encrypted.connection.id)).includes(fixture.marker));
  record('Encryption-only mode is distinct from full hostname verification',{connection:encrypted.connection});
  const noTls=await mustFail({sslMode:'disable',sslRootCert:undefined});record('Required server encryption does not silently fall back to plaintext',{error:noTls});
  if(['mysql','mariadb'].includes(provider)){
    const absent=await mustFail({user:'geod_client'});record('Client-certificate account rejects a password-only connection',{error:absent});
    const mutual=await connect({user:'geod_client',sslClientCert:fs.readFileSync(path.join(privateRoot,'client.pem'),'utf8'),sslClientKey:fs.readFileSync(path.join(privateRoot,'client.key'),'utf8')});assert(!mutual.error,mutual.error?.code);assert.equal(mutual.connection.clientCertificate,true);assert(JSON.stringify(await read(mutual.connection.id)).includes(fixture.marker));
    const key=fs.readFileSync(path.join(privateRoot,'client.key'),'utf8'),nativeRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','sql-inputs');let sealed;
    for(const owner of fs.readdirSync(nativeRoot)){const file=path.join(nativeRoot,owner,'certificates',mutual.connection.id+'.client-tls');if(fs.existsSync(file))sealed=fs.readFileSync(file);}
    assert(sealed&&sealed.length>100);assert(!sealed.includes(Buffer.from(key)));record('Actual mTLS reads data and stores the client key only as DPAPI ciphertext',{connection:mutual.connection,sealedBytes:sealed.length,sealedSha256:createHash('sha256').update(sealed).digest('hex')});
    const wrongClient=await mustFail({user:'geod_client',sslClientCert:fs.readFileSync(path.join(privateRoot,'wrong-client.pem'),'utf8'),sslClientKey:fs.readFileSync(path.join(privateRoot,'wrong-client.key'),'utf8')});record('Untrusted client certificate is rejected',{error:wrongClient});
    qa[provider]={connectionId:valid.connection.id,mutualId:mutual.connection.id,fixtureId:fixture.fixtureId};
  }else qa[provider]={connectionId:valid.connection.id,fixtureId:fixture.fixtureId};
  await assert.rejects(rpc('sql_query',{connectionId:valid.connection.id,sql:`DELETE FROM ${fixture.table} WHERE 1=0`}),error=>error.code==='INPUT_READ_ONLY');record('TLS connections retain actual read-only SQL enforcement');
  const all=(await rpc('sql_connections_list')).connections;assert(all.every(connection=>!Object.hasOwn(connection,'password')&&!Object.hasOwn(connection,'sslClientKey')));
  for(const owner of fs.readdirSync(path.join(process.env.APPDATA,'dev.geod-agent.desktop','sql-inputs'))){const tmp=path.join(process.env.APPDATA,'dev.geod-agent.desktop','sql-inputs',owner,'tmp');if(fs.existsSync(tmp))assert.equal(fs.readdirSync(tmp).filter(name=>name.startsWith('.sql-tls-session-')).length,0);}
  record('Completed sessions remove their plaintext material; public metadata contains no credentials');
  report.passed=true;
}catch(error){report.error={code:error?.code,message:error?.message||String(error)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(qa){qa.owned=[...new Set([...qa.owned,...saved])];write('qa-state.json',qa);}
  write(`${provider}-native-result.json`,report);await browser.close();
}
