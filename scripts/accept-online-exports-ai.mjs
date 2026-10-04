/** Actual UI model tool loop; controlled HTTP is released after closing the GUI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
let browser,page,connectionId,released=false,conversationId;
const waiting=[];const nonce=crypto.randomBytes(6).toString('hex'),token=crypto.randomUUID();
const features=[{type:'Feature',id:1,properties:{name:`actual-point-${nonce}`,score:41},geometry:{type:'Point',coordinates:[116.2,39.7]}},{type:'Feature',id:2,properties:{name:`actual-road-${nonce}`,score:42},geometry:{type:'LineString',coordinates:[[116.2,39.7],[116.3,39.8]]}}];
const fixture=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
  if(req.headers.authorization!==`Bearer ${token}`||u.searchParams.get('token')!==token){res.writeHead(401);res.end('{}');return;}
  if(u.pathname==='/collections'){res.end(JSON.stringify({collections:[{id:'sample',title:'私有点线数据'}]}));return;}
  const respond=()=>{const offset=Number(u.searchParams.get('offset')??0);if(!res.destroyed)res.end(JSON.stringify({type:'FeatureCollection',numberMatched:2,features:[features[offset]],links:offset===0?[{rel:'next',href:'/collections/sample/items?offset=1'}]:[]}));};
  if(released)respond();else waiting.push(respond);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const connect=async()=>{for(let i=0;i<150;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');break;}catch(error){if(i===149)throw error;await new Promise(r=>setTimeout(r,100));}}page=null;for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(r=>setTimeout(r,100));}if(!page)throw new Error('Actual desktop not ready');await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);};
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(result.error)throw result.error;return result.value;};
const chats=()=>page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v)));
const send=async prompt=>{await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({timeout:15000});await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({state:'hidden',timeout:150000});return(await chats()).find(c=>c.conversationId===conversationId);};
const probe=(command,args={})=>{const value=JSON.parse(execFileSync('python',['-X','utf8','scripts/background-runtime-probe.py','rpc','--command',command,'--args',JSON.stringify(args)],{cwd:process.cwd(),encoding:'utf8',windowsHide:true}));if(!value.ok)throw new Error(JSON.stringify(value.error));return value.result;};
const report={pass:false,cases:[],nonce};
try{
  if(['--resume','--load-only','--readback-only'].includes(process.argv[4])){
    const previous=JSON.parse(await fs.readFile(path.join(evidencePath,'ai-acceptance.json'),'utf8'));Object.assign(report,previous,{pass:false,cases:previous.cases.filter(c=>c.pass)});
    const passed=report.cases.find(c=>c.conversationId&&c.taskId);if(!passed)throw new Error('Passed native background evidence missing');conversationId=passed.conversationId;connectionId=probe('data_download_get',{conversationId,taskId:passed.taskId}).request.spec.onlineConnectionId;released=true;
    await connect();
  }else{
  await connect();const known=new Set((await chats()).map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();
  for(let i=0;i<100;i++){conversationId=(await chats()).find(c=>!known.has(c.conversationId))?.conversationId;if(conversationId)break;await new Promise(r=>setTimeout(r,100));}
  if(!conversationId)throw new Error('Actual new conversation missing');
  const workspace=await rpc('workspace_get',{conversationId});
  await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});report.workspace=workspace.directory;
  const name=`私有在线数据验收 ${nonce}`;
  const c=await rpc('online_connection_save',{draft:{name,url:`http://127.0.0.1:${fixture.address().port}/collections?token=${token}`,headers:{Authorization:`Bearer ${token}`}}});connectionId=c.id;
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
  const chat=await send(`请通过扩展工具发现已保存的“${name}”在线连接，确认目录中的 sample 图层，然后通过数据下载工具创建并启动它的在线矢量下载。任务名为“私有点线数据 ${nonce}”，输出 GeoJSON 和 GeoPackage，分页大小 1，最多 2 个要素。当前会话是完全访问权限。启动后结束回复，让本机后台执行，不要反复查询进度，不要用命令行替代这些工具。`);
  if(JSON.stringify(chat).includes(token))throw new Error('Private credential entered model conversation');
  const traces=JSON.stringify(chat.display.filter(m=>m.role==='tool'));
  if(!traces.includes('online_services_discover')||!traces.includes('data_download_plan')||!traces.includes('data_download_start'))throw new Error('Actual discover/plan/start sequence missing');
  let tasks=await rpc('data_download_list',{conversationId});const task=tasks.find(t=>t.kind==='online'&&t.title.includes(nonce));
  if(!task||task.status!=='downloading')throw new Error(`Actual download not in background: ${task?.status}`);
  const endpoint=path.join(process.env.APPDATA,'dev.geod-agent.desktop','background-endpoint.json');
  const before=JSON.parse(await fs.readFile(endpoint,'utf8')).pid;
  try{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close'));}catch(error){if(!String(error).includes('closed'))throw error;}
  await browser.close();browser=null;released=true;for(const respond of waiting)respond();
  let finished;
  for(let i=0;i<80;i++){finished=probe('data_download_get',{conversationId,taskId:task.id});if(['completed','failed','cancelled'].includes(finished.status))break;await new Promise(r=>setTimeout(r,500));}
  if(finished?.status!=='completed')throw new Error(finished?.error??'Background did not complete');
  const after=JSON.parse(await fs.readFile(endpoint,'utf8')).pid;if(before!==after)throw new Error('Background process restarted');
  const actual=JSON.parse(await fs.readFile(path.join(finished.outputDir,'features.geojson'),'utf8'));
  if(actual.features.length!==2||!actual.features.some(f=>f.properties.name===`actual-road-${nonce}`))throw new Error('Actual downloaded values missing');
  report.cases.push({name:'Actual UI model discovers private service, plans/starts export; same companion finishes after GUI closes',pass:true,conversationId,taskId:task.id,backgroundPid:before,manifest:finished.manifest,initialAnswer:chat.messages.at(-1).content});
  execFileSync('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{cwd:process.cwd(),encoding:'utf8',windowsHide:true});await connect();
  }
  const saved=(await chats()).find(c=>c.conversationId===conversationId);
  const title=saved.title||saved.display.find(m=>m.role==='user').content.slice(0,34);
  await page.locator('.conversation-item').filter({hasText:title}).first().click();
  let chat=(await chats()).find(c=>c.conversationId===conversationId);
  if(!['--load-only','--readback-only'].includes(process.argv[4])){
  chat=await send('请用数据下载成果检查工具核验刚才的这项任务。只回复它的真实文件格式、要素数量、几何类型和已完成状态，不要重新下载或用命令替代工具。');
  const verification=JSON.stringify(chat.display.filter(m=>m.role==='tool'));
  if(!verification.includes('data_download_inspect')||!verification.includes('Point')||!verification.includes('LineString'))throw new Error('Actual model inspection of native manifest missing');
  if(JSON.stringify(chat).includes(token))throw new Error('Credential leaked on resumed model turn');
  report.cases.push({name:'Reopened desktop resumes actual Codex conversation and model inspects verified native output',pass:true,answer:chat.messages.at(-1).content});
  }
  if(process.argv[4]!=='--readback-only')chat=await send('把刚才已核验完成的这份私有点线矢量成果加载到当前地图，不要重新下载。用实际地图状态确认点和线已经可见，回复加载结果即可。');
  const loads=chat.display.filter(m=>m.role==='tool'&&m.toolName==='data_download_load'&&m.toolStatus==='success').map(m=>JSON.parse(m.details).result);
  const loaded=loads.find(r=>r.loaded&&r.featureCount===2);if(!loaded)throw new Error('Actual native output did not load into live OpenLayers view');
  const live=await page.evaluate(async({id,layerId})=>{const m=await import('/src/openlayers-mcp.ts');return{layers:await m.openLayersCall(id,'listLayers',{}),features:await m.openLayersCall(id,'listFeatures',{layerId})};},{id:conversationId,layerId:loaded.layerId});
  if(!live.layers.some(l=>l.id===loaded.layerId&&l.visible&&l.state==='ready'&&l.featureCount===2)||live.features.map(f=>f.type).sort().join(',')!=='LineString,Point')throw new Error('Live OpenLayers state differs from loaded native output');
  report.cases.push({name:'Actual model loads completed private online point/line output into live OpenLayers map',pass:true,answer:chat.messages.at(-1).content,live});
  await fs.writeFile(path.join(evidencePath,'actual-ai-conversation.json'),JSON.stringify(chat,null,2));await page.screenshot({path:path.join(evidencePath,'actual-ai-export.png')});report.pass=true;
}catch(error){report.cases.push({name:'actual private online AI/background',pass:false,error:String(error.message??error)});}
finally{
  released=true;for(const respond of waiting)respond();
  if(!browser){execFileSync('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{cwd:process.cwd(),windowsHide:true});await connect().catch(()=>{});}
  if(page&&connectionId)await rpc('online_connection_remove',{connectionId}).catch(()=>{});
  if(browser)await browser.close();fixture.closeAllConnections();fixture.close();report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidencePath,'ai-acceptance.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.map(c=>({name:c.name,pass:c.pass,error:c.error}))}));if(!report.pass)process.exitCode=1;
