import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';import {resolve,join} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const output=resolve('../../artifacts/task-cleanup-20261012');mkdirSync(output,{recursive:true});
const config=join('C:/Users/Administrator/AppData/Roaming/dev.geod-agent.desktop-preview','agent-services.json');const previous=existsSync(config)?readFileSync(config):null;
const fixture={identity_origin:'http://127.0.0.1:48193',access_token:'task-cleanup-qa',refresh_token:'task-cleanup-qa-refresh',user_id:'credit-history-native-fixture',access_expires_at:Math.floor(Date.now()/1000)+3600};
function credential(action){const r=spawnSync('python',['-X','utf8','test/credit-history-native-support.py',action],{input:JSON.stringify(fixture),encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);}
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('127.0.0.1:1426'));
assert(page);const call=(command,args={})=>page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args}).then(r=>{if(r.error)throw r.error;return r.value;});
let seeded=false,changed=false;const report={passed:false,modelCalls:0,liveAccountMutations:0,checks:[]};
const conversationId=randomUUID(),workspace=join(output,'native-workspace-'+randomUUID());mkdirSync(workspace);
try{
 const background=await call('background_status');assert.equal(background.activeDownloads,0);assert(!background.activeAiTurns&&!background.activeCommands);
 credential('seed');seeded=true;writeFileSync(config,JSON.stringify({identityOrigin:fixture.identity_origin,gatewayOrigin:fixture.identity_origin}));changed=true;
 assert.equal((await call('auth_status')).userId,fixture.user_id);
 await call('workspace_set',{conversationId,directory:workspace,permission:'confirmEach',outputCrs:'EPSG:4326'});
 assert.deepEqual(await call('imagery_tasks_list',{conversationId}),[]);report.checks.push('empty conversation native listing');
 const sourceId='cleanup-qa-'+randomUUID();await call('sources_save',{endpoint:{id:sourceId,name:'Task cleanup Esri QA',attribution:'Esri',license:'Source terms',urlTemplate:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',scheme:'XYZ',tileSize:256,networkPolicy:'PublicHttps',minIntervalMs:0},minZoom:0,maxZoom:22,replaceExisting:false,credential:null});
 const plan=await call('plans_create',{conversationId,toolExecutionId:'cleanup-qa-'+randomUUID(),spec:{schemaVersion:'0.1',kind:'imagery',sourceId,bounds:[116.398,39.913,116.399,39.914],zoomLevels:[15],outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326'},outputDirectory:join(workspace,'imagery'),limits:{maxTiles:4,maxDecodedRgbaBytes:33554432}}});
 const args={conversationId,planIds:[plan.planId]};const approval=await call('approvals_grant',{planId:plan.planId,planHash:plan.plan.planHash});
 let result=await call('imagery_tasks_cleanup',{...args,action:'discard'});assert.deepEqual(result.changed,[plan.planId]);assert.equal((await call('imagery_tasks_list',{conversationId}))[0].recordState,'discarded');
 const start={planId:plan.planId,planHash:plan.plan.planHash,approvalId:approval.approvalId,idempotencyKey:'cleanup-qa-'+randomUUID()};
 let blocked;try{await call('jobs_start',start);}catch(e){blocked=e;}assert.equal(blocked?.code,'PLAN_DISCARDED');report.checks.push('durable discard blocks a previously approved native start');
 await call('imagery_tasks_cleanup',{...args,action:'restore'});
 let job=await call('jobs_start',start);const deadline=Date.now()+90000;
 result=await call('imagery_tasks_cleanup',{...args,action:'clean'});assert.equal(result.changed.length,0);assert.equal(result.rejected[0].code,'JOB_STATE_CONFLICT');report.checks.push('running job cleanup rejected');
 while(!['completed','partial','failed','cancelled'].includes(job.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));job=await call('jobs_get',{jobId:job.jobId});}
 assert.equal(job.state,'completed');while((await call('jobs_active')).includes(job.jobId)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
 const manifest=await call('artifacts_inspect',{jobId:job.jobId}),files=manifest.assets.map(a=>{const path=resolve(plan.plan.spec.outputDirectory,a.path);return{path,bytes:readFileSync(path)}});
 result=await call('imagery_tasks_cleanup',{conversationId,planIds:[plan.planId,'unknown-plan',plan.planId],action:'clean'});assert.deepEqual(result.changed,[plan.planId]);assert.equal(result.rejected.length,1);assert.equal(result.filesPreserved,true);
 assert.equal((await call('imagery_tasks_list',{conversationId}))[0].recordState,'cleaned');
 const foreign=await call('imagery_tasks_cleanup',{conversationId:randomUUID(),planIds:[plan.planId],action:'restore'});assert.equal(foreign.rejected[0].code,'PLAN_NOT_OWNED');
 // Restart the native companion, not the user interface, and read its durable state.
 await call('background_stop');await call('background_start');assert.equal((await call('imagery_tasks_list',{conversationId}))[0].recordState,'cleaned');
 await call('imagery_tasks_cleanup',{...args,action:'restore'});assert.equal((await call('jobs_get',{jobId:job.jobId})).state,'completed');
 for(const f of files)assert.deepEqual(readFileSync(f.path),f.bytes);report.checks.push('completed files unchanged, partial batch reporting, foreign conversation denied, companion restart persistence and restore');
 const data=await call('data_download_plan',{conversationId,title:'清理测试三维计划',idempotencyKey:'cleanup-data-'+randomUUID(),request:{kind:'tiles3d',spec:{tilesetUrl:'https://example.org/tileset.json'}}});
 assert.equal((await call('data_download_cleanup',{conversationId,taskId:data.id,action:'clean'})).cleaned,true);
 const restored=await call('data_download_cleanup',{conversationId,taskId:data.id,action:'restore'});assert.equal(restored.cleaned,false);assert.equal(restored.status,'pending');
 await call('data_download_cleanup',{conversationId,taskId:data.id,action:'clean'});await call('imagery_tasks_cleanup',{...args,action:'clean'});
 report.checks.push('native 3D plan cleanup and restore retains original state');report.planId=plan.planId;report.jobId=job.jobId;report.conversationId=conversationId;report.passed=true;
}catch(e){report.error=JSON.stringify(e);throw e;}finally{
 if(changed){if(previous)writeFileSync(config,previous);else unlinkSync(config);}if(seeded)credential('delete');report.settingsRestored=true;
 writeFileSync(join(output,'native-acceptance.json'),JSON.stringify(report,null,2));await page.goto('http://127.0.0.1:1426/').catch(()=>{});await browser.close();console.log(JSON.stringify(report));
}
