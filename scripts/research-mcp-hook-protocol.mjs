/** Probe the actual pinned Codex MCP Hook protocol without a model service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
const hiddenTools=process.argv.includes('--hidden-tools'),prefix=hiddenTools?'hidden-protocol':'protocol';
const output=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-hooks'),root=path.join(output,prefix+'-'+randomUUID()),home=path.join(root,'home'),workspace=path.join(root,'workspace');for(const folder of [output,home,workspace])fs.mkdirSync(folder,{recursive:true});
const audit=[],tools=[{name:'record_hook',description:'Record actual Hook input',inputSchema:{type:'object',properties:{event:{type:'string'},cwd:{type:'string'}},required:['event','cwd'],additionalProperties:false},annotations:{readOnlyHint:true}}];
const fixture=http.createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(405).end();return;}
 let text='';for await(const chunk of req)text+=chunk;const request=JSON.parse(text);audit.push(request);if(request.id===undefined){res.writeHead(202).end();return;}
 const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'actual-hook-qa',version:'1.0.0'}}:request.method==='tools/list'?{tools:hiddenTools?[]:tools}:request.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({hookSpecificOutput:{hookEventName:request.params.arguments.event,additionalContext:'Actual MCP Hook protocol marker'}})}]}:{};
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
fs.writeFileSync(path.join(home,'config.toml'),'model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="No model request"\nbase_url="http://127.0.0.1:9"\nwire_api="responses"\n[features]\nhooks=true\n[mcp_servers.hook_fixture]\nurl="http://127.0.0.1:'+fixture.address().port+'/mcp"\ndefault_tools_approval_mode="approve"\n');
const placeholder=name=>'$'+'{'+name+'}',handler={type:'mcp_tool',server:'hook_fixture',tool:'record_hook',input:{event:placeholder('hook_event_name'),cwd:placeholder('cwd')},timeout:5};fs.writeFileSync(path.join(home,'hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[handler]}],UserPromptSubmit:[{hooks:[handler]}]}}));
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CODEX_'))),child=spawn(path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex/codex.exe'),['app-server','--stdio','--enable','hooks'],{cwd:workspace,env:{...environment,CODEX_HOME:home,CODEX_SQLITE_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
let serial=0,stderr='';const pending=new Map(),events=[],rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timeout '+method));},30000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const waiter=pending.get(value.id);if(waiter&&!value.method){clearTimeout(waiter.timer);pending.delete(value.id);value.error?waiter.reject(new Error(JSON.stringify(value.error))):waiter.resolve(value.result);}else events.push(value);});child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-16000));
const report={passed:false,root};
try{
 await rpc('initialize',{clientInfo:{name:'geod_mcp_hook_protocol_qa',version:'0.2.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const before=await rpc('hooks/list',{cwds:[workspace]});fs.writeFileSync(path.join(output,prefix+'-before-review.json'),JSON.stringify(before,null,2));const hooks=before.data.flatMap(item=>item.hooks);assert.equal(hooks.length,2);assert(hooks.every(hook=>hook.trustStatus==='untrusted'));
 await rpc('config/batchWrite',{edits:[{keyPath:'hooks.state',value:Object.fromEntries(hooks.map(hook=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}])),mergeStrategy:'upsert'}],reloadUserConfig:true});
 const thread=await rpc('thread/start',{cwd:workspace,model:'fixture-model',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'});await rpc('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Local protocol verification only; no model service is configured.'}]});
 const end=Date.now()+15000;while(audit.filter(item=>item.method==='tools/call').length<2&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,150));const calls=audit.filter(item=>item.method==='tools/call');assert.equal(calls.length,2);assert.deepEqual(calls.map(item=>item.params.arguments.event).sort(),['SessionStart','UserPromptSubmit']);assert(calls.every(item=>item.params.arguments.cwd===workspace));const inventory=await rpc('mcpServerStatus/list',{});if(hiddenTools)assert.equal(inventory.data.flatMap(item=>Object.values(item.tools??{})).length,0);report.passed=true;report.hiddenTools=hiddenTools;report.inventory=inventory;report.actualCalls=calls;report.handlerTypes=hooks.map(hook=>hook.handlerType);
}catch(error){report.error={message:error.message,stderr};throw error;}
finally{
 fs.writeFileSync(path.join(output,prefix+'-result.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,prefix+'-audit.json'),JSON.stringify(audit,null,2));fs.writeFileSync(path.join(output,prefix+'-events.json'),JSON.stringify(events,null,2));child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},4000);child.once('exit',()=>{clearTimeout(timer);resolve();});});fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));console.log(JSON.stringify({passed:report.passed,hiddenTools,handlerTypes:report.handlerTypes,error:report.error}));
}
