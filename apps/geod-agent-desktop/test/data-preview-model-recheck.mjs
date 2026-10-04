import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:1420'));
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const conversationId='ee9141af-d285-48c4-ad20-1d0974b0ac2b',vectorId='312eb292-6294-4706-8d4c-d39991e45d2b',tiles3dId='ac885d0c-0255-4da4-bdef-f717df496d66';
const auth=await rpc('auth_status'),key=`geod-agent-conversations-0.1:account:${auth.userId}`,output=resolve('../../docs/implementation/evidence/data-app-real-model');
const read=()=>page.evaluate(({key,id})=>JSON.parse(localStorage.getItem(key)||'[]').find(c=>c.conversationId===id),{key,id:conversationId});
try{
 assert((await page.locator('.agent-header').textContent()).startsWith('矢量数据验收'));
 const baseline=new Set((await read()).display.map(m=>m.id));
 await page.getByRole('textbox',{name:'发送给 GeoD Agent',exact:true}).fill(`请再次核验已完成的三维任务 ${tiles3dId} 并加载到当前三维预览，成功后说明实际结果。不要创建新的下载任务。`);
 await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({timeout:15000});await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({state:'hidden',timeout:180000});
 await page.waitForTimeout(300);
 const chat=await read(),calls=chat.display.filter(m=>m.toolName&&!baseline.has(m.id)).map(m=>({tool:m.toolName,status:m.toolStatus,...JSON.parse(m.details)}));
 assert(calls.some(c=>c.tool==='data_download_load'&&c.result?.taskId===tiles3dId&&c.result?.loaded===true),JSON.stringify(calls));
 assert(await page.getByRole('button',{name:'定位三维成果',exact:true}).isEnabled());
 await page.screenshot({path:resolve(output,'tiles3d-app.png')});
 const vector=await rpc('data_download_inspect',{conversationId,taskId:vectorId}),tiles3d=await rpc('data_download_inspect',{conversationId,taskId:tiles3dId});
 const allCalls=chat.display.filter(m=>m.toolName).map(m=>({tool:m.toolName,status:m.toolStatus,...JSON.parse(m.details)}));
 assert(allCalls.some(c=>c.tool==='data_download_load'&&c.result?.taskId===vectorId&&c.result?.loaded===true));
 writeFileSync(resolve(output,'acceptance.json'),JSON.stringify({pass:true,conversationId,engine:chat.engine,modelUsage:chat.codexContext,vector,tiles3d,calls:allCalls,recheckCalls:calls,answers:chat.messages.filter(m=>m.role==='assistant'&&m.content).map(m=>m.content),notes:['Original live acceptance found and fixed new vector-layer creation and encoded bundle-directory preview bugs. This recheck uses the same verified tasks and the real model/production preview.','One first 3D download attempt failed due to network; the actual model retried successfully.']},null,2));
 console.log(JSON.stringify({pass:true,conversationId,vectorFeatures:vector.manifest.featureCount,tiles3dFiles:tiles3d.manifest.resources.length,calls,output}));
}catch(error){console.error(error);process.exitCode=1;}finally{setTimeout(()=>process.exit(process.exitCode??0),100);}
