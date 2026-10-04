// Real native Skills/scripts and MCP probe; no keyboard, mouse or focus changes.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const page=(await(await fetch('http://127.0.0.1:9233/json')).json()).find(p=>p.type==='page'&&p.url.includes('127.0.0.1:1420'));
if(!page)throw new Error('Wait for the development desktop to finish loading');
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let serial=0;const pending=new Map();
socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const callback=pending.get(value.id);pending.delete(value.id);value.error?callback?.reject(new Error(value.error.message)):callback?.resolve(value.result);}});
function command(method,params){return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}

const root=mkdtempSync(join(tmpdir(),'geod-complete-skill-'));
const folder=join(root,'geod-runtime-probe');mkdirSync(join(folder,'references'),{recursive:true});mkdirSync(join(folder,'scripts'));
const marker=randomUUID();
writeFileSync(join(folder,'SKILL.md'),'---\nname: geod-runtime-probe\ndescription: Convert the test point GeoJSON to CSV using the bundled script and reference configuration.\n---\nWhen requested, read references/config.json, then run scripts/convert.py with the current workspace input points.geojson and output skill-points.csv. The script reads the adjacent reference file. Use native command execution. Report the actual marker and count from the script output.\n');
writeFileSync(join(folder,'references/config.json'),JSON.stringify({marker,crs:4326}));
writeFileSync(join(folder,'scripts/convert.py'),`from pathlib import Path
import csv,json,sys
config=json.loads((Path(__file__).resolve().parent.parent/'references/config.json').read_text(encoding='utf-8'))
data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
with Path(sys.argv[2]).open('w',newline='',encoding='utf-8') as stream:
 writer=csv.writer(stream);writer.writerow(['name','longitude','latitude'])
 for feature in data['features']:
  writer.writerow([feature['properties']['name'],*feature['geometry']['coordinates']])
print(json.dumps({'marker':config['marker'],'featureCount':len(data['features']),'output':sys.argv[2]}))
`);
writeFileSync(join(root,'points.geojson'),JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{name:'skill-probe'},geometry:{type:'Point',coordinates:[116.4,39.9]}}]}));
let importedId;
try{
 const setup=await evaluate(`(async()=>{
  const {api}=await import('/src/api.ts');const conversationId='resources-'+crypto.randomUUID();await api.workspaceSet(conversationId,${JSON.stringify(root)},'fullAccess');
  const old=(await api.extensionsList()).skills.find(s=>s.name==='geod-runtime-probe'&&s.description==='Convert the test point GeoJSON to CSV using the bundled script and reference configuration.');if(old)await api.skillRemove(old.id);
  const overview=await api.skillImport(${JSON.stringify(folder)});const imported=overview.skills.find(s=>s.name==='geod-runtime-probe');await api.skillSetEnabled(imported.id,true);
  return {conversationId,id:imported.id};
 })()`);importedId=setup.id;
 // Only remove the generated fixture inside this exact temporary workspace.
 assert.equal(join(root,'geod-runtime-probe'),folder);assert.ok(root.startsWith(join(tmpdir(),'geod-complete-skill-')));rmSync(folder,{recursive:true});
 const result=await evaluate(`(async()=>{
  const {api}=await import('/src/api.ts');const {runCodexTurn}=await import('/src/codex-client.ts');const conversationId=${JSON.stringify(setup.conversationId)};
  const events=[],generations=[],calls=[];
  const hooks={onEvent:e=>{if(e.type==='event'&&['item/completed','item/started','thread/tokenUsage/updated'].includes(e.method))events.push(e);if(e.type==='inventory')window.__geodRuntimeInventory=e},onModel:()=>{},onGeneration:g=>generations.push({state:g.state,inputTokens:g.inputTokens,outputTokens:g.outputTokens}),onRequest:async()=>{throw new Error('Unexpected interactive request in Full Access probe')},execute:async call=>{calls.push(call.function.name);if(call.function.name==='workspace_status')return {result:await api.workspaceGet(conversationId)};return {result:{error:'USE_NATIVE_RUNTIME_TOOLS_FOR_THIS_PROBE'}}}};
   const skill=await runCodexTurn(crypto.randomUUID(),conversationId,'使用 $geod-runtime-probe 这个完整 Skill，将 points.geojson 转为 skill-points.csv。请实际读取附带的 references/config.json 并执行 scripts/convert.py；用一句中文报告脚本返回的 marker 和要素数。',[],hooks);
   const mcp=await runCodexTurn(crypto.randomUUID(),conversationId,'请通过已启用 humaps 连接器的原生 MCP search_map_layers 查询 China，limit 为 10，不要使用 GeoD 的 mcp_call 包装。只查询一次，简短报告实际找到的图层数量。',[],hooks);
   return {skill,mcp,calls,generations,items:events.filter(e=>e.method==='item/completed').map(e=>e.params.item)};
 })()`);
 writeFileSync(join(root,'runtime-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,skill:result.skill.text,mcp:result.mcp.text,commands:result.items.filter(item=>item.type==='commandExecution')},null,2));
 const output=join(root,'skill-points.csv');assert.ok(existsSync(output),'The native command must produce the actual CSV');
 const csv=readFileSync(output,'utf8');assert.match(csv,/skill-probe,116.4,39.9/);assert.ok(result.skill.text.includes(marker),'The model must read and report the actual resource marker');
 assert.ok(result.items.some(item=>item.type==='commandExecution'&&item.exitCode===0&&item.aggregatedOutput?.includes(marker)));
 assert.ok(result.items.some(item=>item.type==='mcpToolCall'&&item.status==='completed'&&item.tool==='search_map_layers'),'Native MCP call must complete');
 const evidence={root,marker,csv,...result};writeFileSync('../../docs/implementation/evidence/codex-resources-live-2026-10-01.json',JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({root,skill:result.skill.text,mcp:result.mcp.text,nativeCommands:result.items.filter(i=>i.type==='commandExecution').length,nativeMcp:result.items.filter(i=>i.type==='mcpToolCall').map(i=>({tool:i.tool,status:i.status})),generations:result.generations},null,2));
}finally{if(importedId)await evaluate(`(async()=>{const {api}=await import('/src/api.ts');await api.skillRemove(${JSON.stringify(importedId)})})()`).catch(()=>{});socket.close();}
