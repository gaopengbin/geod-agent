/** Invoke lifecycle and hash trust in the actual bundled engine, without a model call. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {preparePluginHooks,reviewPluginHookTrust} from '../apps/geod-agent-desktop/src-tauri/codex-host.mjs';
const output=path.resolve('artifacts/product-gaps-20261004/plugin-hooks'),root=path.join(output,'protocol-'+randomUUID()),home=path.join(root,'home'),workspace=path.join(root,'workspace'),pkg=path.join(root,'package with spaces'),data=path.join(root,'data');
for(const directory of [home,workspace,pkg,data])fs.mkdirSync(directory,{recursive:true});
fs.copyFileSync('apps/geod-agent-desktop/src-tauri/plugin-hook-runner.mjs',path.join(home,'plugin-hook-runner.mjs'));
fs.writeFileSync(path.join(pkg,'collect.mjs'),"import fs from 'node:fs';let text='';process.stdin.setEncoding('utf8');for await(const part of process.stdin)text+=part;const event=JSON.parse(text);fs.appendFileSync(process.env.PLUGIN_DATA+'/events.jsonl',JSON.stringify({event,root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,bridgeVisible:Boolean(process.env.GEOD_CODEX_BRIDGE_TOKEN)})+'\\n');if(event.hook_event_name==='SessionStart')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'Actual bundled hook marker HOOK_PROTOCOL_OK'}}));");
fs.writeFileSync(path.join(home,'config.toml'),'model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="No model request"\nbase_url="http://127.0.0.1:9"\nwire_api="responses"\n[features]\nhooks=true\n');
const group={pluginId:randomUUID(),pluginName:'Protocol fixture',packageRoot:pkg,dataRoot:data,event:'SessionStart',matcher:'startup|resume',handlers:[{type:'command',command:'node "'+'$'+'{PLUGIN_ROOT}/collect.mjs"',timeout:10}]};
const prepared=preparePluginHooks(home,[group]),pending=new Map(),notifications=[];let serial=0,stderr='';
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CODEX_')));
const child=spawn(path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex/codex.exe'),['app-server','--stdio','--enable','hooks'],{cwd:workspace,env:{...environment,CODEX_HOME:home,CODEX_SQLITE_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-16000));
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timeout '+method));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const target=pending.get(value.id);if(target&&!value.method){clearTimeout(target.timer);pending.delete(value.id);value.error?target.reject(new Error(JSON.stringify(value.error))):target.resolve(value.result);}else notifications.push(value);});
child.on('exit',code=>{for(const target of pending.values()){clearTimeout(target.timer);target.reject(new Error('Engine exit '+code+' '+stderr));}pending.clear();});
const report={passed:false,cases:[],root};
try{
  await rpc('initialize',{clientInfo:{name:'geod_hook_protocol_qa',version:'0.2.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const untrusted=await rpc('hooks/list',{cwds:[workspace]});fs.writeFileSync(path.join(output,'protocol-before-review.json'),JSON.stringify(untrusted,null,2));
  assert.equal(untrusted.data[0].hooks.length,1);assert.equal(untrusted.data[0].hooks[0].trustStatus,'untrusted');assert(!fs.existsSync(path.join(data,'events.jsonl')));
  report.cases.push({name:'Real engine discovers owned commands but does not execute them during review',passed:true});
  await reviewPluginHookTrust(rpc,prepared,workspace);
  const trusted=await rpc('hooks/list',{cwds:[workspace]});assert.equal(trusted.data[0].hooks[0].trustStatus,'trusted');
  report.cases.push({name:'Real engine trusts only the exact reviewed definition hash',passed:true});
  const thread=await rpc('thread/start',{cwd:workspace,model:'fixture-model',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'});
  await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Only verify local hooks. No model service is configured.'}]});
  const deadline=Date.now()+15000;while(!fs.existsSync(path.join(data,'events.jsonl'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,150));
  assert(fs.existsSync(path.join(data,'events.jsonl')),'SessionStart did not execute');
  const actual=fs.readFileSync(path.join(data,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(actual[0].event.hook_event_name,'SessionStart');assert.equal(actual[0].root,pkg);assert.equal(actual[0].data,data);assert.equal(actual[0].bridgeVisible,false);
  report.cases.push({name:'Actual SessionStart executes quoted package scripts with native input and scoped environment',passed:true,threadId:thread.thread.id,actual});
  fs.writeFileSync(path.join(output,'protocol-events.json'),JSON.stringify(notifications,null,2));report.passed=true;
}catch(error){report.error={message:error.message,stderr};throw error;}
finally{
  fs.writeFileSync(path.join(output,'protocol-events.json'),JSON.stringify(notifications,null,2));fs.writeFileSync(path.join(output,'protocol-result.json'),JSON.stringify(report,null,2));child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,error:report.error}));
}
