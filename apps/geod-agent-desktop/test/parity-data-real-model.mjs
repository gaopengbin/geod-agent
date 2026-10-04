// The actual desktop chat sends real Codex/model turns and executes the production
// data tools. Assertions read native manifests and the actual rendered map.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const rpc=async(command,args={})=>{const result=await (await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://127.0.0.1:1420'));assert(page,'Actual desktop page is missing');
const output=resolve('../../docs/implementation/evidence/data-app-real-model');mkdirSync(output,{recursive:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const account=await rpc('auth_status');assert.equal(account.state,'connected');
const key=`geod-agent-conversations-0.1:account:${account.userId}`;
const chats=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),key);
let conversationId='',taskIds=[],passed=false;
const readChat=async()=>{const values=await chats();return values.find(chat=>chat.conversationId===conversationId);};
const send=async(input)=>{await page.getByRole('textbox',{name:'发送给 GeoD Agent',exact:true}).fill(input);await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({timeout:15000});await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({state:'hidden',timeout:240000});await page.waitForTimeout(250);};
const waitTask=async(kind)=>{const until=Date.now()+120000;let found;while(Date.now()<until){found=(await rpc('data_download_list',{conversationId})).find(task=>task.kind===kind);if(found&&['completed','partial','failed','cancelled'].includes(found.status))break;await new Promise(r=>setTimeout(r,400));}assert(found,`Model did not create ${kind} task`);assert.equal(found.status,'completed',JSON.stringify(found));taskIds.push(found.id);return rpc('data_download_inspect',{conversationId,taskId:found.id});};
const calls=async()=>{const chat=await readChat();return (chat?.display??[]).filter(item=>item.role==='tool'&&item.toolName).map(item=>{let details={};try{details=JSON.parse(item.details||'{}');}catch{}return {tool:item.toolName,status:item.toolStatus,...details};});};
const loaded=async(id)=>(await calls()).some(call=>call.tool==='data_download_load'&&call.result?.taskId===id&&call.result?.loaded===true);
try {
 const previous=new Set((await chats()).map(chat=>chat.conversationId));
 await page.locator('.sidebar-new-chat').click();
 for(let attempt=0;attempt<50;attempt++){const added=(await chats()).find(chat=>!previous.has(chat.conversationId));if(added){conversationId=added.conversationId;break;}await new Promise(r=>setTimeout(r,100));}
 assert(conversationId,'New test conversation missing');
 const workspace=(await rpc('workspace_get',{conversationId})).directory;
 await page.getByRole('button',{name:'工作区权限：每次确认，点击切换',exact:true}).click();await page.locator('.composer-permission-menu button').filter({hasText:'完全访问'}).click();await page.getByRole('button',{name:'确认允许完全访问',exact:true}).click();await page.getByRole('button',{name:'工作区权限：完全访问，点击切换',exact:true}).waitFor();
 await send('矢量数据验收：请通过数据下载工具规划并启动一个小型 MVT 矢量任务，名称“柏林国家矢量验收”。地址 https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf ，范围 [13.404,52.52,13.406,52.522]，只取 Z2，输出 GeoJSON 和 GeoPackage。完成后核验成果并加载到当前地图。当前已完全访问，可直接执行。这是矢量任务，不需要影像图源。');
 const vector=await waitTask('vector');assert.equal(vector.manifest.featureCount,1);
 if(!await loaded(vector.id))await send(`矢量任务 ${vector.id} 已完成，请现在核验成果并加载到当前地图。`);
 assert(await loaded(vector.id),'Model load result must come from actual map completion');
 const layers=await page.evaluate(async conversationId=>{const {openLayersCall}=await import('/src/openlayers-mcp.ts');return openLayersCall(conversationId,'listLayers',{});},conversationId);
 assert(Array.isArray(layers)&&layers.some(layer=>layer.id===`download-${vector.id}`),JSON.stringify(layers));
 await page.screenshot({path:resolve(output,'vector-app.png')});
 await send('三维数据验收：请通过数据下载工具规划并启动一个 3D Tiles 任务，名称“三维官方样例验收”。地址 https://cdn.jsdelivr.net/gh/CesiumGS/3d-tiles-samples@a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56/1.0/TilesetWithRequestVolume/tileset.json ，获取完整样例，不限制范围。完成后核验并加载离线三维预览。当前完全访问，可直接执行。');
 const tiles3d=await waitTask('tiles3d');assert(tiles3d.manifest.resources.length>1);
 if(!await loaded(tiles3d.id))await send(`三维任务 ${tiles3d.id} 已完成，请核验成果并加载到当前地图里的三维预览。`);
 assert(await loaded(tiles3d.id),'Model 3D load must wait for actual Cesium readiness');
 await page.getByRole('button',{name:'定位三维成果',exact:true}).waitFor();assert(await page.getByRole('button',{name:'定位三维成果',exact:true}).isEnabled());
 const canvas=await page.locator('.tiles3d-preview canvas').boundingBox();assert(canvas&&canvas.width>100&&canvas.height>100);await page.screenshot({path:resolve(output,'tiles3d-app.png')});
 const chat=await readChat(),toolCalls=await calls();
 assert(toolCalls.filter(call=>call.tool==='data_download_plan').length>=2);assert(toolCalls.filter(call=>call.tool==='data_download_start').length>=2);
 assert(!toolCalls.some(call=>call.result?.error),JSON.stringify(toolCalls.filter(call=>call.result?.error)));
 writeFileSync(resolve(output,'acceptance.json'),JSON.stringify({pass:true,conversationId,workspace,engine:chat.engine,modelUsage:chat.codexContext,calls:toolCalls,answers:chat.messages.filter(m=>m.role==='assistant'&&m.content).map(m=>m.content),vector,tiles3d,layers,canvas,errors},null,2));
 console.log(JSON.stringify({pass:true,conversationId,vectorId:vector.id,tiles3dId:tiles3d.id,features:vector.manifest.featureCount,files:tiles3d.manifest.resources.length,tools:toolCalls.map(call=>call.tool),output}));passed=true;
} catch(error) {
 await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});writeFileSync(resolve(output,'failure.json'),JSON.stringify({conversationId,taskIds,error:String(error),errors,chat:await readChat().catch(()=>null)},null,2));console.error(error);process.exitCode=1;
} finally {
 // Disconnect the test process, never close the user's native WebView/browser.
 if(!passed&&await page.getByRole('button',{name:'停止回复',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'停止回复',exact:true}).click().catch(()=>{});
 setTimeout(()=>process.exit(process.exitCode??0),100);
}
