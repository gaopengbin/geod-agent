/** Actual saved Windows credentials, Cesium Ion, production provider and hosted AI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const[modulePath,output]=process.argv.slice(2),{chromium}=await import(modulePath);
await fs.mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let attempt=0;attempt<100&&!page;attempt++){
  page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
  if(!page)await new Promise(resolve=>setTimeout(resolve,200));
}
assert(page,'GeoD desktop page did not finish opening');
const report={pass:false,cases:[]},requests=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.url().includes('geod-terrain.localhost')||/api\.cesium\.com|assets\.cesium\.com/.test(r.url()))requests.push({url:r.url(),status:r.status()});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),wait=async(run,label,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await run();if(value)return value;await sleep(300);}throw new Error(`Timeout: ${label}`);};
const passed=async(name,result)=>{report.cases.push({name,pass:true,result});await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(name,'PASS');};
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw Object.assign(new Error(JSON.stringify(r.error)),r.error);return r.value;};
const chats=()=>page.evaluate(async()=>{const{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v));});
let conversationId,capability;
const scene=(name,args={},conversation=conversationId)=>page.evaluate(async({conversation,name,args})=>{
  const module=performance.getEntriesByType('resource').filter(r=>/\/src\/cesium-mcp\.ts\?t=/.test(r.name)).at(-1)?.name??'/src/cesium-mcp.ts';
  return(await import(module)).cesiumCall(conversation,name,args);
},{conversation,name,args});
async function ask(message){const count=(await chats()).find(c=>c.conversationId===conversationId)?.display.filter(d=>d.role==='user').length??0;await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(message);await page.getByRole('button',{name:'发送消息',exact:true}).click();const chat=await wait(async()=>{const chat=(await chats()).find(c=>c.conversationId===conversationId);return chat&&!chat.pendingId&&chat.display.filter(d=>d.role==='user').length>count&&chat.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?chat:null;},'Actual hosted model turn',180000);return chat;}
try{
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();assert.equal(await page.getByRole('button',{name:'停止回复',exact:true}).count(),0);
  const connections=await rpc('tiles3d_connections_list'),connection=connections.find(c=>c.kind==='cesiumIon'&&c.credentialReady);assert(connection);
  const before=new Set((await chats()).map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();conversationId=await wait(async()=>(await chats()).find(c=>!before.has(c.conversationId))?.conversationId,'Actual new conversation');
  const workspace=await rpc('workspace_get',{conversationId});await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
  await ask('这是 Ion 地形的本地验收会话，稍后加载真实场景。现在只简短回复“可以开始”。');
  let task=await rpc('data_download_plan',{conversationId,title:'Ion 地形验收 · Cesium 官方样例',idempotencyKey:crypto.randomUUID(),request:{kind:'tiles3d',spec:{tilesetUrl:'https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56/1.0/TilesetWithRequestVolume/tileset.json'}}});
  await rpc('data_download_start_auto',{conversationId,taskId:task.id,planHash:task.planHash});task=await wait(async()=>{const t=await rpc('data_download_get',{conversationId,taskId:task.id});if(t.status==='failed')throw new Error(t.error);return t.status==='completed'?t:null;},'Native public bundle');
  const loaded=await page.evaluate(async({conversationId,task})=>(await import('/src/data-downloads.ts')).previewDataTask(conversationId,task),{conversationId,task});assert.equal(loaded.loaded,true);
  const terrain=await scene('loadTerrain',{provider:'cesiumion',connectionId:connection.id,cesiumIonAssetId:1});assert.equal(terrain.success,true,JSON.stringify(terrain));assert.equal(terrain.data.assetId,1);
  const state=await scene('getSceneState');assert.equal(state.data.terrain.provider,'cesiumIon');assert(state.data.terrain.connection.loaded>0);await passed('Production Cesium loads actual Ion terrain through the saved native credential',{conversationId,taskId:task.id,terrain,state:state.data.terrain});
  const heights=await scene('sampleTerrain',{positions:[{longitude:86.925,latitude:27.988},{longitude:6.865,latitude:45.8328}],level:12});assert.equal(heights.success,true,JSON.stringify(heights));assert(heights.data.positions[0].height>7000&&heights.data.positions[0].height<10000);assert(heights.data.positions[1].height>3500&&heights.data.positions[1].height<5000);
  const view=await scene('setView',{longitude:86.925,latitude:27.988,height:22000,heading:0,pitch:-45});assert.equal(view.success,true,JSON.stringify(view));
  const visible=await wait(async()=>{const s=await scene('getSceneState');return s.data.terrain.tilesLoaded&&s.data.terrain.connection.loaded>5?s:null;},'Actual terrain tiles finish rendering');
  await sleep(1000);await page.screenshot({path:path.join(output,'actual-ion-terrain.png')});await passed('Actual quantized mesh sampling returns mountain elevations',{heights:heights.data,terrain:visible.data.terrain,requests:requests.filter(r=>r.url.includes('geod-terrain.localhost')).length});
  const rejected=await scene('loadTerrain',{provider:'cesiumion',connectionId:connection.id,cesiumIonAssetId:96188});assert.equal(rejected.success,false);const kept=await scene('getSceneState');assert.equal(kept.data.terrain.connection.assetId,1);
  const unknown=await scene('loadTerrain',{provider:'cesiumion',connectionId:crypto.randomUUID(),cesiumIonAssetId:1});assert.equal(unknown.success,false);await passed('Wrong asset kind and unknown saved connection fail while preserving the current terrain',{rejected,unknown,terrain:kept.data.terrain});
  capability=await rpc('ion_terrain_open',{conversationId,connectionId:connection.id,assetId:1});
  const resource=await page.evaluate(async capability=>{const{ionTerrain}=await import('/src/cesium-terrain.ts');const url=ionTerrain.url(capability)+'layer.json';const response=await fetch(url);return{url,status:response.status,metadata:await response.json()};},capability);
  assert.equal(resource.status,200);assert(resource.metadata.tiles.every(t=>t.startsWith('../')&&!t.includes('token')));assert(!JSON.stringify(resource.metadata).includes('access_token'));
  await rpc('ion_terrain_close',{sessionId:capability.sessionId});const retired=await page.evaluate(async url=>(await fetch(url)).status,resource.url);assert.equal(retired,404);capability=null;
  await passed('Native terrain metadata uses opaque local templates; closing the registration revokes access',{status:resource.status,templates:resource.metadata.tiles,retiredStatus:retired});
  const ai=await ask(`请通过 Cesium MCP 使用已保存的 Ion 连接 ${connection.id} 加载全球地形（Asset ID 1），然后实际采样珠峰附近经纬度 86.925,27.988 的高程（level 12）。用中文简短说明你读到的真实高程，不要返回密钥或内部资源地址。`);
  const last=ai.display.findLastIndex(d=>d.role==='user'),trace=ai.display.slice(last+1).filter(d=>d.role==='tool');assert(JSON.stringify(trace).includes('loadTerrain'));assert(JSON.stringify(trace).includes('sampleTerrain'));assert(/\d{4}/.test(ai.messages.at(-1).content));await fs.writeFile(path.join(output,'actual-ai.json'),JSON.stringify(ai,null,2));await passed('Actual hosted AI selects the saved connection and reads real terrain elevation',{conversationId,answer:ai.messages.at(-1).content});
  const flat=await scene('loadTerrain',{provider:'flat'});assert.equal(flat.success,true);assert.equal((await scene('getSceneState')).data.terrain.provider,'flat');await passed('Switching to flat releases the private terrain provider',flat);
  assert(!requests.some(r=>/api\.cesium\.com|assets\.cesium\.com/.test(r.url)),'Ion endpoint or credentials reached browser network');assert(!requests.some(r=>/access_token=|Bearer/.test(r.url)));assert.equal(errors.length,0,JSON.stringify(errors));report.pass=true;
}catch(error){report.error=String(error);process.exitCode=1;}finally{
  if(capability)await rpc('ion_terrain_close',{sessionId:capability.sessionId}).catch(()=>{});
  report.browserRequests=requests;report.pageErrors=errors;await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,error:report.error}));await browser.close();
}
