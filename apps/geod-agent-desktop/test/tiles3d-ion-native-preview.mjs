import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const conversationId='ion-buildings-4d47a261-2cd6-41e1-ae3d-473831f572bd',taskId='560bcca1-fe3e-416c-9341-38d9a4a6b792';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:1420'));
assert(page);const output=resolve('../../docs/implementation/evidence/tiles3d-ion-preview');mkdirSync(output,{recursive:true});
try{
 assert(!await page.getByRole('button',{name:'停止回复',exact:true}).isVisible());
 const task=await rpc('data_download_inspect',{conversationId,taskId});assert.equal(task.status,'completed');assert.equal(task.manifest.resources.length,18);
 const workspace=await rpc('workspace_get',{conversationId}),auth=await rpc('auth_status');
 const key=`geod-agent-conversations-0.1:account:${auth.userId}`;
 // Add only this real native test task's empty conversation metadata. No model
 // answer or fabricated tool history is inserted into the conversation.
 await page.evaluate(({key,conversationId,directory})=>{const chats=JSON.parse(localStorage.getItem(key)||'[]'),existing=chats.find(c=>c.conversationId===conversationId);localStorage.setItem(key,JSON.stringify([existing??{conversationId,workspaceDirectory:directory,messages:[],display:[],planIds:[],updatedAt:new Date().toISOString(),engine:'codex'},...chats.filter(c=>c.conversationId!==conversationId)]));},{key,conversationId,directory:workspace.directory});
 await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent',exact:true}).waitFor({timeout:30000});
 // Wait until the actual App host has mounted the selected native conversation.
 await page.waitForTimeout(1000);
 const loaded=await rpc('test_domain_tool',{conversationId,tool:'data_download_load',arguments:{taskId},executionId:'ion-actual-preview'});
 assert.equal(loaded.loaded,true,JSON.stringify(loaded));
 await page.getByRole('button',{name:'定位三维成果',exact:true}).waitFor({timeout:30000});assert(await page.getByRole('button',{name:'定位三维成果',exact:true}).isEnabled());
 await page.waitForTimeout(1200);
 await page.screenshot({path:resolve(output,'beijing-cbd.png')});
 const viewport=page.locator('.tiles3d-preview__canvas'),initial=await viewport.screenshot();
 const box=await viewport.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,700);await page.waitForTimeout(600);
 const moved=await viewport.screenshot();assert(!initial.equals(moved),'Camera wheel interaction must actually change the view');
 await page.getByRole('button',{name:'定位三维成果',exact:true}).click();await page.waitForTimeout(600);
 const reset=await viewport.screenshot();assert(!moved.equals(reset),'Recenter must move the camera back from the displaced view');
 await page.screenshot({path:resolve(output,'beijing-cbd-reset.png')});
 const nativePreview=await rpc('data_download_preview',{conversationId,taskId});await rpc('data_asset_unregister',{token:nativePreview.token});
 assert(nativePreview.bounds?.length===4);
 const result={pass:true,conversationId,taskId,loaded,bounds:nativePreview.bounds,resources:task.manifest.resources.length,bytes:task.manifest.totalBytes,screenshot:resolve(output,'beijing-cbd.png'),checks:['production DataPreviewHost and native geod-data assets','Cesium initialTilesLoaded resolves actual load','download bounds supplied despite global asset root','camera wheel interaction changes rendered view','recenter restores view from displaced camera'],checkedAt:new Date().toISOString()};
 writeFileSync(resolve(output,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page.screenshot({path:resolve(output,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}finally{setTimeout(()=>process.exit(process.exitCode??0),100);}
