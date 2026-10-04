/** Real extracted installer, clean app profiles, upgrade and packaged tool execution. */
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const[modulePath,output]=process.argv.slice(2),{chromium}=await import(modulePath),exec=promisify(execFile);
const root=path.resolve(output),report={pass:false,cases:[],freshWindowsVerified:false},errors=[],ownedTasks=[],ownedSchedules=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(300);}throw new Error(`Timeout: ${label}`);};
const sha=async file=>{const hash=crypto.createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const helper=(script,...args)=>exec('python',['-X','utf8',script,...args],{windowsHide:true});
const save=()=>fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));
const passed=async(name,result)=>{report.cases.push({name,pass:true,result});await save();console.log(name,'PASS');};
let browser,page,isolated=false,lastMode='predecessor',connectionId,conversationId,seedConversation,originalStatus;
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw Object.assign(new Error(JSON.stringify(r.error)),r.error);return r.value;};
async function connect(port=9234){return wait(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420')||p.url().includes('tauri.localhost'));if(page){await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor({timeout:15000});page.on('pageerror',e=>errors.push(e.message));return true;}await browser.close();browser=null;}catch{}},'Actual desktop '+port,45000);}
async function closeWindow(){try{await rpc('plugin:window|close');}catch(e){if(!String(e).includes('closed'))throw e;}await browser.close();browser=null;page=null;await sleep(1500);}
async function launch(mode){lastMode=mode;await helper('scripts/launch-release-qa.py',mode,root);await connect();}
async function taskDone(owner,id){return wait(async()=>{const detail=await rpc('agent_tasks_get',{conversationId:owner,taskId:id});return ['completed','failed','cancelled','interrupted'].includes(detail.task.status)?detail:null;},'Packaged file agent '+id);}
async function spawn(owner,name,prompt,inputFiles=[]){const task=await rpc('agent_tasks_spawn',{conversationId:owner,idempotencyKey:crypto.randomUUID(),draft:{name,prompt,inputFiles,readOnly:false}});ownedTasks.push([owner,task.id]);return task;}
const chats=()=>page.evaluate(async()=>{
  await window.__GEOD_LOCAL_STATE__?.flush();
  return new Promise((resolve,reject)=>{const opened=indexedDB.open('geod-ui-state-v1',1);opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const db=opened.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();tx.oncomplete=()=>{db.close();resolve(keys.result.flatMap((key,i)=>String(key).startsWith('geod-agent-conversations-0.1:account:')?JSON.parse(values.result[i]):[]));};tx.onabort=()=>{db.close();reject(tx.error);};};});
});
async function ask(text){const n=(await chats()).find(c=>c.conversationId===conversationId)?.display.filter(d=>d.role==='user').length??0;await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();return wait(async()=>{const chat=(await chats()).find(c=>c.conversationId===conversationId);return chat&&!chat.pendingId&&chat.display.filter(d=>d.role==='user').length>n&&chat.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?chat:null;},'Actual packaged parent Agent',240000);}
try{
  const candidate=JSON.parse(await fs.readFile(path.join(root,'candidate.json'),'utf8')),payload=path.join(root,'installer-payload');assert.equal(candidate.version,'0.2.0');
  const payloadExecutable=path.join(payload,'geod-agent-desktop.exe'),payloadExecutableSha256=await sha(payloadExecutable);
  // Tauri changes only its bundle-type marker when wrapping the release in NSIS.
  const executableBytes=await fs.readFile(payloadExecutable),portableMarker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),installedMarker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const markerOffset=executableBytes.indexOf(installedMarker);assert(markerOffset>=0);assert.equal(executableBytes.indexOf(installedMarker,markerOffset+1),-1);assert.equal(executableBytes.indexOf(portableMarker),-1);
  portableMarker.copy(executableBytes,markerOffset);assert.equal(crypto.createHash('sha256').update(executableBytes).digest('hex'),candidate.mainExecutableSha256,'Only the documented Tauri NSIS bundle marker may differ');
  assert.equal(await sha(path.join(payload,'LICENSE.txt')),await sha(path.resolve('LICENSE')));
  const verified={};
  for(const[name,expected]of Object.entries(candidate.runtimeVerification)){
    const folder=path.join(payload,name),manifestFile=path.join(folder,'manifest.json');assert.equal(await sha(manifestFile),expected.manifestSha256);
    const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
    for(const[file,spec]of Object.entries(manifest.files)){const target=path.resolve(folder,file);assert(target.startsWith(folder+path.sep));assert.equal(await sha(target),typeof spec==='string'?spec:spec.sha256,name+'/'+file);}
    verified[name]=Object.keys(manifest.files).length;
  }
  await passed('Actual installer payload matches the candidate executable except its Tauri NSIS bundle marker; licenses and every pinned runtime file match',{installerExecutableSha256:payloadExecutableSha256,portableExecutableSha256:candidate.mainExecutableSha256,markerOffset,verified});
  await connect(9233);originalStatus=await rpc('background_status');const jobs=await rpc('jobs_active');assert(!jobs.length);assert(!originalStatus.activeDownloads&&!originalStatus.activeCommands&&!originalStatus.activeAiTurns&&!originalStatus.maintenanceActive);assert.equal(await page.getByRole('button',{name:'停止回复',exact:true}).count(),0);
  await page.evaluate(()=>window.__GEOD_LOCAL_STATE__?.flush());await rpc('background_stop');await closeWindow();await helper('scripts/release-qa-profiles.py','isolate',root);isolated=true;
  await launch('predecessor');const beforeVersion=await rpc('plugin:app|version');assert.equal(beforeVersion,'0.1.0');assert.equal((await rpc('auth_status')).state,'connected');
  const work=path.join(root,'qa-workspace');await fs.mkdir(work,{recursive:true});const seed={nonce:crypto.randomBytes(16).toString('hex'),values:[10,20]};await fs.writeFile(path.join(work,'input.json'),JSON.stringify(seed));
  seedConversation='release-seed-'+crypto.randomUUID();await rpc('workspace_set',{conversationId:seedConversation,directory:work,permission:'fullAccess'});
  const seeded=await spawn(seedConversation,'升级前文件分析','实际读取 input.json，计算 values 总和，保存 result.json，包含 nonce 和 sum。', ['input.json']);
  const seedResult=await taskDone(seedConversation,seeded.id);assert.equal(seedResult.task.status,'completed',JSON.stringify(seedResult.task));const seedFile=seedResult.files.find(f=>f.path==='result.json'||f.path.endsWith('/result.json'))?.path;assert(seedFile);
  const rawSeed=(await rpc('agent_tasks_read_file',{conversationId:seedConversation,taskId:seeded.id,path:seedFile})).text,savedSeed=JSON.parse(rawSeed);assert.equal(savedSeed.nonce,seed.nonce);assert.equal(savedSeed.sum,30);
  const seedReceipt=await rpc('billing_run_snapshot',{runId:seedResult.task.runId});assert(seedReceipt.generations.length>0&&seedReceipt.usageResolved);assert.equal(seedReceipt.status,'completed');
  const draft=JSON.parse(await fs.readFile('infra/postgis-test/.secrets/reader-connection.json','utf8'));const oldConnection=await rpc('data_connection_save',{draft:{...draft,name:'发行升级连接验收'}});connectionId=oldConnection.connection.id;
  assert(!oldConnection.error,JSON.stringify(oldConnection));const databaseLayer=oldConnection.layers.find(l=>l.name==='demo.boundaries_4326.geom')?.name;assert(databaseLayer,JSON.stringify(oldConnection.layers));const beforeRows=await rpc('data_layer_inspect',{connectionId,layer:databaseLayer,limit:3});assert(!beforeRows.error,JSON.stringify(beforeRows));assert(beforeRows.featureCount>0);
  const oldBackground=await rpc('background_status');assert.equal(oldBackground.activeAiTurns,0);await closeWindow();
  await launch('candidate');const version=await rpc('plugin:app|version');assert.equal(version,'0.2.0');const upgraded=await rpc('background_status');assert.notEqual(upgraded.pid,oldBackground.pid);assert.equal(upgraded.fingerprint,payloadExecutableSha256);
  const retained=await rpc('agent_tasks_get',{conversationId:seedConversation,taskId:seeded.id});assert.equal(retained.task.status,'completed');assert.equal(retained.task.runId,seedResult.task.runId);assert.equal((await rpc('agent_tasks_read_file',{conversationId:seedConversation,taskId:seeded.id,path:seedFile})).text,rawSeed);
  const exactSeed=(await rpc('agent_tasks_read_file',{conversationId:seedConversation,taskId:seeded.id,path:seedFile})).text;assert.deepEqual(JSON.parse(exactSeed),savedSeed);
  const retainedReceipt=await rpc('billing_run_snapshot',{runId:retained.task.runId});assert.equal(retainedReceipt.status,seedReceipt.status);assert.deepEqual(retainedReceipt.generations.map(g=>g.generationId),seedReceipt.generations.map(g=>g.generationId));assert(retainedReceipt.usageResolved);
  assert((await rpc('data_connections_list')).some(c=>c.id===connectionId));const rows=await rpc('data_layer_inspect',{connectionId,layer:databaseLayer,limit:3});assert(!rows.error,JSON.stringify(rows));assert.equal(rows.featureCount,beforeRows.featureCount);assert.equal(rows.mcp.server,'pgedge-postgres-mcp');assert.deepEqual(rows.sampleRecords,beforeRows.sampleRecords);
  await passed('An idle 0.1 debug companion is upgraded to the actual 0.2 release; owned results, receipts and database connections survive',{versions:[beforeVersion,version],pids:[oldBackground.pid,upgraded.pid],taskId:seeded.id,runId:retained.task.runId,retainedGenerationIds:retainedReceipt.generations.map(g=>g.generationId),retainedLayer:databaseLayer,retainedRows:rows.featureCount});
  const known=new Set((await chats()).map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();conversationId=await wait(async()=>(await chats()).find(c=>!known.has(c.conversationId))?.conversationId,'Release conversation');
  const parentDirectory=(await rpc('workspace_get',{conversationId})).directory;await rpc('workspace_set',{conversationId,directory:parentDirectory,permission:'fullAccess'});
  const inputDirectory='release-qa-'+crypto.randomBytes(6).toString('hex');await fs.mkdir(path.join(parentDirectory,inputDirectory),{recursive:true});const data={nonce:crypto.randomBytes(16).toString('hex'),values:[3,7,11]};await fs.writeFile(path.join(parentDirectory,inputDirectory,'data.json'),JSON.stringify(data));
  const child=await spawn(conversationId,'发行版实际文件分析',`实际读取 ${inputDirectory}/data.json，计算 values 总和，把 nonce 和 sum 保存为 result.json。`,[`${inputDirectory}/data.json`]);const result=await taskDone(conversationId,child.id);assert.equal(result.task.status,'completed',JSON.stringify(result.task));
  const resultPath=result.files.find(f=>f.path==='result.json'||f.path.endsWith('/result.json'))?.path;assert(resultPath);const actual=JSON.parse((await rpc('agent_tasks_read_file',{conversationId,taskId:child.id,path:resultPath})).text);assert.equal(actual.nonce,data.nonce);assert.equal(actual.sum,21);const receipt=await rpc('billing_run_snapshot',{runId:result.task.runId});assert(receipt.generations.length>0&&receipt.usageResolved);assert.equal(receipt.status,'completed');
  await passed('Packaged Codex and Node execute actual isolated file tools and settle hosted model receipts on a stock Windows PATH',{task:result.task,receipt});
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Packaged editable composer');
  const answered=await ask('请查看当前会话已经完成的“发行版实际文件分析”子任务，读取它实际保存的 result.json。只告诉我文件里的 nonce 和 sum，不重新启动任务。');assert.equal(answered.engine,'codex');assert(answered.codexContext?.inputTokens>0);assert(answered.messages.at(-1).content.includes(data.nonce));assert(answered.messages.at(-1).content.includes('21'));assert(answered.display.some(d=>d.role==='tool'&&d.toolName==='agent_tasks_read_file'));await passed('The actual release composer calls the native tool and the AI answers from the saved result',{answer:answered.messages.at(-1).content,engine:answered.engine,context:answered.codexContext});
  const vectorPath=path.join(parentDirectory,inputDirectory,'range.sqlite');const source={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'发行版矢量范围'},geometry:{type:'Polygon',coordinates:[[[116.1,39.6],[116.3,39.6],[116.3,39.8],[116.1,39.8],[116.1,39.6]]]}}]};
  const python=`import json,geopandas\nf=geopandas.GeoDataFrame.from_features(json.loads(${JSON.stringify(JSON.stringify(source))}),crs='EPSG:4326').to_crs('EPSG:3857')\nf.to_file(${JSON.stringify(vectorPath)},driver='SQLite',layer='ranges')`;
  await exec(path.join(payload,'gdal-runtime/python.exe'),['-I','-X','utf8','-c',python],{windowsHide:true});
  const input=await rpc('data_input_read',{conversationId,request:{relativePath:`${inputDirectory}/range.sqlite`,layer:'ranges'}});assert.equal(input.boundary.polygonCount,1);input.boundary.bounds.forEach((v,i)=>assert(Math.abs(v-[116.1,39.6,116.3,39.8][i])<1e-6));
  let extensions=await rpc('extensions_list'),gdal=extensions.connectors.find(c=>c.transport==='gdalStdio');if(!gdal){extensions=await rpc('mcp_add_gdal');gdal=extensions.connectors.find(c=>c.transport==='gdalStdio');}await rpc('mcp_set_enabled',{id:gdal.id,enabled:true});
  const tools=await rpc('mcp_tools',{id:gdal.id,conversationId});assert(tools.tools.some(t=>t.name==='vector_info'));const info=await rpc('mcp_call',{id:gdal.id,conversationId,toolName:'vector_info',arguments:{uri:`${inputDirectory}/range.sqlite`},executionId:crypto.randomUUID()});assert(!info.isError,JSON.stringify(info));await passed('The actual installer supplies Python/GDAL and pgEdge for vector input, MCP inspection and real database reads',{bounds:input.boundary.bounds,gdalTool:'vector_info',databaseServer:rows.mcp.server});
  const background=await spawn(conversationId,'发行版关窗后分析',`实际读取 ${inputDirectory}/data.json，依次保存 sum.txt、count.txt、max.txt、min.txt，最后保存 nonce.txt。内容必须来自真实输入。`,[`${inputDirectory}/data.json`]);await wait(async()=>(await rpc('agent_tasks_get',{conversationId,taskId:background.id})).task.threadId,'Release worker booted');const running=await rpc('background_status');assert(running.activeAiTurns>0);await closeWindow();await sleep(22000);await launch('candidate');const completed=await taskDone(conversationId,background.id);assert.equal(completed.task.status,'completed',JSON.stringify(completed.task));assert.equal((await rpc('background_status')).pid,running.pid);const noncePath=completed.files.find(f=>f.path==='nonce.txt'||f.path.endsWith('/nonce.txt'))?.path;assert(noncePath);assert.equal((await rpc('agent_tasks_read_file',{conversationId,taskId:background.id,path:noncePath})).text.trim(),data.nonce);
  await passed('The packaged worker continues with the window closed and reconnects to the same release companion',{taskId:background.id,pid:running.pid,files:completed.files});
  const scheduleArgs={conversationId,name:'发行版停机后补执行',prompt:`先调用 workspace_status，再实际读取 ${inputDirectory}/data.json。简洁回答文件里的 nonce 和 values 总和，不修改文件，不启动新任务。`,nextRunAt:new Date(Date.now()+8000).toISOString(),repeatSeconds:null,executionId:crypto.randomUUID()};
  const scheduled=await rpc('ai_schedules_create',scheduleArgs);ownedSchedules.push([conversationId,scheduled.scheduleId]);assert.equal((await rpc('ai_schedules_create',scheduleArgs)).scheduleId,scheduled.scheduleId);
  await rpc('background_stop');await closeWindow();await sleep(10000);await launch('candidate');
  const recovered=await wait(async()=>{const listed=await rpc('ai_schedules_list',{conversationId});const run=listed.runs.find(r=>r.scheduleId===scheduled.scheduleId);return run&&['succeeded','failed','waiting_input','interrupted'].includes(run.state)?run:null;},'Overdue packaged AI schedule',240000);
  assert.equal(recovered.state,'succeeded',JSON.stringify(recovered));assert(recovered.result.text.includes(data.nonce));assert(recovered.result.text.includes('21'));
  const scheduledTrace=await rpc('ai_schedules_run_events',{runId:recovered.runId});assert(scheduledTrace.events.some(e=>e.type==='toolResult'&&e.tool==='workspace_status'));assert(scheduledTrace.events.some(e=>e.type==='generationResult'&&(e.generation.inputTokens??0)>0&&(e.generation.outputTokens??0)>0));
  await rpc('background_stop');await closeWindow();await launch('candidate');await sleep(6000);
  const reruns=(await rpc('ai_schedules_list',{conversationId})).runs.filter(r=>r.scheduleId===scheduled.scheduleId);assert.equal(reruns.length,1);assert.equal(reruns[0].runId,recovered.runId);assert.equal((await rpc('ai_schedules_create',scheduleArgs)).scheduleId,scheduled.scheduleId);
  await passed('A one-time AI instruction missed while stopped executes after packaged startup and is not duplicated on the next restart',{scheduleId:scheduled.scheduleId,runId:recovered.runId,answer:recovered.result.text,runsAfterRestart:reruns.length});
  await page.screenshot({path:path.join(root,'release-real-model.png')});assert.equal(errors.length,0,JSON.stringify(errors));report.pass=true;
}catch(error){report.error=String(error);console.error(report.error);process.exitCode=1;}
finally{
  if(isolated){
    try{
      if(!browser||!page)await launch(lastMode);
      if(await page.getByRole('button',{name:'停止回复',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'停止回复',exact:true}).click();
      for(const[owner,taskId]of ownedTasks)await rpc('agent_tasks_cancel',{conversationId:owner,taskId}).catch(()=>{});
      for(const[owner,scheduleId]of ownedSchedules){await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});const listed=await rpc('ai_schedules_list',{conversationId:owner}).catch(()=>({runs:[]}));for(const run of listed.runs.filter(r=>r.scheduleId===scheduleId&&['running','queued','waiting_input','interrupted'].includes(r.state)))await rpc('ai_schedules_cancel_run',{runId:run.runId}).catch(()=>{});}
      await wait(async()=>{const s=await rpc('background_status');return !s.activeDownloads&&!s.activeCommands&&!s.activeAiTurns&&!s.maintenanceActive;},'Idle QA companion',90000);
      if(connectionId)await rpc('data_connection_remove',{connectionId}).catch(()=>{});
      await rpc('background_stop');await closeWindow();
      await wait(async()=>{try{await helper('scripts/release-qa-profiles.py','restore',root);return true;}catch{return false;}},'Restore original profiles',30000);
      report.originalProfilesRestored=true;
    }catch(error){report.cleanupError=String(error);report.pass=false;process.exitCode=1;console.error('QA cleanup failed:',String(error));}
  }
  if(browser)await browser.close().catch(()=>{});report.pageErrors=errors;report.originalBackgroundPid=originalStatus?.pid;report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,restored:report.originalProfilesRestored,error:report.error,cleanupError:report.cleanupError}));
}
