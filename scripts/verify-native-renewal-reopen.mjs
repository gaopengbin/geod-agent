// Narrow diagnosis: real native credential renewal followed by a new WebView.
// Uses an existing stopped QA binary and a fresh, loopback-only fake identity.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,openSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGatewayServer,readConfig} from '../services/geod-agent-model-gateway/server.mjs';
import {createScheduleIdentity} from './schedule-identity-fixture.mjs';
import {runJsonProcess} from './schedule-rpc-process.mjs';
import {writeReceipt} from './schedule-acceptance-receipts.mjs';

const root=resolve(process.argv[2]??'');
assert(root.startsWith(resolve('artifacts/schedule-stability-native-20261005')+'\\fixture-'));
const ownerRoot=resolve(process.argv[3]??root);
const restartAfterRenewal=process.argv.includes('--restart-after-renewal');
const renewals=Number(process.argv.find(value=>value.startsWith('--renewals='))?.split('=')[1]??1);
assert(Number.isInteger(renewals)&&renewals>=1&&renewals<=4);
assert(ownerRoot.startsWith(resolve('artifacts/schedule-stability-native-20261005')+'\\fixture-'));
const exe=join(root,'target/release/geod-agent-desktop.exe');
const binarySha=createHash('sha256').update(readFileSync(exe)).digest('hex');
let provenance;
if(existsSync(join(root,'current-source-qa-build.json'))){
  provenance=JSON.parse(readFileSync(join(root,'current-source-qa-build.json'),'utf8'));
  assert(provenance.passed);assert.equal(provenance.identifier,'dev.geod-agent.credit-history-qa');
  assert.equal(provenance.qaExecutableSha256,binarySha);assert.deepEqual(provenance.changedProductInputs,[]);
  for(const [name,digest] of Object.entries(provenance.sourceSnapshotBeforeBuild))assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'),digest,'QA source differs from '+name);
}else if(existsSync(join(root,'payload.json'))){
  const payload=await runJsonProcess('python',['-X','utf8','-c','import json,sys; sys.path.insert(0,"scripts"); from schedule_qa_identity import read_run,read_build; value=json.loads(sys.stdin.read()); payload=read_run(value["root"]); read_build(payload["currentSourceQaBuild"]); print(json.dumps(payload))'],{root});
  provenance=JSON.parse(readFileSync(join(payload.currentSourceQaBuild,'current-source-qa-build.json'),'utf8'));
  assert.equal(provenance.qaExecutableSha256,binarySha);
}else assert.equal(binarySha,'4b5f8ca2b213090da27785d7fc17d01e67532742126273bb7c56b880c79bd885');
const recorded=JSON.parse(readFileSync(join(ownerRoot,'ownership.json'),'utf8'));
assert.equal(recorded.account,'credit-history-native-fixture');
assert.equal(recorded.profile,'dev.geod-agent.credit-history-qa');
assert.equal(recorded.exe.toLowerCase(),join(ownerRoot,'target/release/geod-agent-desktop.exe').toLowerCase());
assert.match(recorded.conversationId,/^[a-f0-9-]{36}$/);
const output=resolve('artifacts/native-renewal-reopen-20261005-'+randomBytes(4).toString('hex'));mkdirSync(output);
const helper=resolve('scripts/schedule-stability-support.py'),credentialHelper=resolve('scripts/schedule-fixture-credential.py');
function support(action,value={}){const result=spawnSync('python',['-X','utf8',helper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
function credential(action,value){const result=spawnSync('python',['-X','utf8',credentialHelper,action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
async function probe(command,args={}){const response=await runJsonProcess('python',['-X','utf8',helper,'rpc'],{command,args});if(!response.ok)throw response.error;return response.result;}
const before=support('snapshot');assert(!before.processes.some(p=>p.exe.toLowerCase().includes('schedule-stability')||p.exe.toLowerCase().includes('credit-history')));
assert.deepEqual(support('profile-audit').enabledScheduleIds,[]);
const account='credit-history-native-fixture',identity=createScheduleIdentity(account,180),owned=[];
const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'no-model-calls',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(output,'model.sqlite')});
const server=identity.wrap(createGatewayServer(config,{fetchImpl:async(url,options)=>{assert(url.endsWith('/api/geod/oauth/introspect'));return Response.json(identity.introspect(JSON.parse(options.body).token));}}));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const report={passed:false,startedAt:new Date().toISOString(),identityOrigin:origin,observations:[],identity:identity.statistics,installed:false,productionModified:false,actualModelCalls:0,
  qaExecutableSha256:binarySha,qaSourceRecordedBeforeBuild:!!provenance,qaVersion:provenance?.version??'0.2.1',
  restartAfterRenewal,renewals,controllerSha256:createHash('sha256').update(readFileSync('scripts/verify-native-renewal-reopen.mjs')).digest('hex')};
const save=()=>writeReceipt(join(output,'result.json'),report);
let browser,page,identitySeeded=false;
const wait=async(check,label,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,500));}throw Error('Timeout: '+label);};
function remember(pid){const value=support('snapshot').processes.find(p=>p.pid===pid&&p.exe.toLowerCase()===exe.toLowerCase());assert(value);if(!owned.some(p=>p.pid===pid&&p.created===value.created))owned.push(value);return value;}
async function observe(phase){const value=await runJsonProcess('python',['-X','utf8','scripts/schedule-fixture-credential-observer.py'],{identityOrigin:origin,account,generations:identity.credentialGenerations});report.observations.push({phase,at:new Date().toISOString(),...value});save();return value;}
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
async function launch(){
  const environment={...process.env,GEOD_AGENT_IDENTITY_ORIGIN:origin,GEOD_AGENT_GATEWAY_ORIGIN:origin,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9236'};
  for(const key of ['TAURI_CONFIG','GEOD_AGENT_DEV_GATEWAY_ORIGIN','TAURI_SIGNING_PRIVATE_KEY','TAURI_SIGNING_PRIVATE_KEY_PASSWORD','TAURI_SIGNING_PRIVATE_KEY_PATH'])delete environment[key];
  const child=spawn(exe,[],{cwd:join(root,'target/release'),env:environment,windowsHide:true,stdio:['ignore',openSync(join(output,'desktop.log'),'a'),openSync(join(output,'desktop-errors.log'),'a')]});
  child.on('error',()=>{});remember(child.pid);
  await wait(async()=>{try{return(await(await fetch('http://127.0.0.1:9236/json/list')).json()).some(p=>/^https?:\/\/tauri\.localhost/.test(p.url));}catch{return false;}},'native WebView navigation');
  browser=await chromium.connectOverCDP('http://127.0.0.1:9236');
  page=await wait(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>/^https?:\/\/tauri\.localhost/.test(p.url())),'connected native page navigation');
  await page.locator('.conversation-account-trigger').waitFor();return remember(child.pid);
}
try{
  credential('seed',{identity_origin:origin,access_token:identity.initial.accessToken,refresh_token:identity.initial.refreshToken,user_id:account,access_expires_at:identity.initial.expiresAt});
  identitySeeded=true;
  await observe('seeded');const foreground=await launch();assert.equal((await invoke('auth_status')).state,'connected');
  const daemon=await invoke('background_status');assert(daemon.running);remember(daemon.pid);
  await invoke('plugin:window|close',{label:'main'}).catch(()=>{});await browser.close();browser=null;page=null;
  await wait(()=>!support('sample',foreground).alive,'first foreground exits');
  for(let generation=1;generation<=renewals;generation++){
    await wait(async()=>{await probe('ai_schedules_list',{conversationId:recorded.conversationId});return identity.statistics.refreshes.length>=generation;},'real wall-time native renewal '+generation,190000);
    const rotated=await observe('wall-time-renewal-'+generation);assert.equal(rotated.refreshGeneration,generation);
  }
  const renewed=await observe('background-renewed');assert.equal(renewed.accessGeneration,renewals);assert.equal(renewed.refreshGeneration,renewals);
  if(restartAfterRenewal){
    const daemonIdentity=remember(daemon.pid);support('terminate',daemonIdentity);
    const stoppedCredential=await observe('renewed-background-exited');assert.equal(stoppedCredential.refreshGeneration,renewals);
    const replacement=support('start-background',{exe,identityOrigin:origin});remember(replacement.pid);
    await wait(async()=>{try{return (await probe('runtime_status')).pid===replacement.pid;}catch{return false;}},'replacement background starts');
    const replacementCredential=await observe('replacement-background-started');assert.equal(replacementCredential.refreshGeneration,renewals);
  }
  await observe('before-reopened-window-launch');
  await launch();await observe('after-reopened-window-load');const status=await invoke('auth_status');report.authStatus=status;save();
  assert.equal(status.state,'connected');assert.equal(status.userId,account);assert.equal(identity.statistics.rejectedRefreshes,0);
  await observe('after-reopened-auth-status');report.passed=true;report.finishedAt=new Date().toISOString();save();
}catch(error){report.failure=error.stack??JSON.stringify(error);save();}
finally{
  await browser?.close().catch(()=>{});
  for(const p of support('snapshot').processes.filter(p=>p.exe.toLowerCase()===exe.toLowerCase()))remember(p.pid);
  const stopped=[];for(const p of owned.toReversed())stopped.push({pid:p.pid,...support('terminate',p)});
  const removed=identitySeeded?credential('delete',{identity_origin:origin}):{fixtureCredentialNotOwned:true};
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  report.cleanup={passed:true,ownedProcesses:stopped,identityRemoved:removed.fixtureCredentialRemoved,originalProcessesUnchanged:JSON.stringify(support('snapshot'))===JSON.stringify(before)};
  assert(report.cleanup.originalProcessesUnchanged);save();
}
console.log(JSON.stringify({output,passed:report.passed,cleanup:report.cleanup}));if(!report.passed)process.exitCode=1;
