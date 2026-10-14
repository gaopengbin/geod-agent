import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const output=resolve('../../artifacts/proxy-first-launch-20261012');mkdirSync(output,{recursive:true});
const profile='C:/Users/Administrator/AppData/Roaming/dev.geod-agent.desktop-preview';
const configPath=join(profile,'agent-services.json'),networkPath=join(profile,'network-settings.json');
const previousConfig=existsSync(configPath)?readFileSync(configPath):null;
assert(!existsSync(networkPath),'First-launch test requires no saved proxy configuration');
const origin='http://127.0.0.1:48193',fixture={identity_origin:origin,access_token:'proxy-first-launch-fixture',refresh_token:'proxy-first-launch-fixture-refresh',user_id:'credit-history-native-fixture',access_expires_at:Math.floor(Date.now()/1000)+3600};
function credential(action){const r=spawnSync('python',['-X','utf8','test/credit-history-native-support.py',action],{input:JSON.stringify(fixture),encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(r.stderr);}
const b=await chromium.connectOverCDP('http://127.0.0.1:9233');const p=b.contexts().flatMap(c=>c.pages())[0];
const call=(command,args={})=>p.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args}).then(r=>{if(r.error)throw new Error(JSON.stringify(r.error));return r.value;});
const batch=process.argv.includes('--batch');
const report={passed:false,modelCalls:0,fullChangpingTask:false,networkSettingsAbsentAtStart:true,batch,jobs:[]};let seeded=false,configurationWritten=false;
const workspace=join(output,'workspace-'+randomUUID());mkdirSync(workspace);
const lon=x=>x/32768*360-180,lat=y=>Math.atan(Math.sinh(Math.PI*(1-2*y/32768)))*180/Math.PI;
async function download(phase,x){
 const id='proxy-qa-'+randomUUID(),conversationId=randomUUID();
 const endpoint={id,name:'Esri auto proxy QA',attribution:'Esri and contributors',license:'Source terms',urlTemplate:'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',scheme:'XYZ',tileSize:256,networkPolicy:'PublicHttps',minIntervalMs:0};
 await call('sources_save',{endpoint,minZoom:0,maxZoom:22,replaceExisting:false,credential:null});
 await call('workspace_set',{conversationId,directory:workspace,permission:'confirmEach',outputCrs:'EPSG:4326'});
 const width=batch?8:1,height=batch?4:1;
 const spec={schemaVersion:'0.1',kind:'imagery',sourceId:id,bounds:[lon(x+.3),lat(12375+height-.3),lon(x+width-.3),lat(12375+.3)],zoomLevels:[15],outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326'},outputDirectory:join(workspace,phase),limits:{maxTiles:width*height,maxDecodedRgbaBytes:33554432}};
 const stored=await call('plans_create',{conversationId,spec,toolExecutionId:'proxy-qa-'+randomUUID()});assert.equal(stored.plan.totalTiles,width*height);
 const approval=await call('approvals_grant',{planId:stored.planId,planHash:stored.plan.planHash});
 const started=Date.now();let job=await call('jobs_start',{planId:stored.planId,planHash:stored.plan.planHash,approvalId:approval.approvalId,idempotencyKey:'proxy-qa-'+randomUUID()});
 const record={phase,jobId:job.jobId,planId:stored.planId,sourceId:id,x,y:12375,z:15,totalTiles:width*height};report.jobs.push(record);
 while(!['completed','partial','failed','cancelled'].includes(job.state)&&Date.now()-started<120000){await new Promise(r=>setTimeout(r,250));job=await call('jobs_get',{jobId:job.jobId});}
 record.state=job.state;record.events=await call('jobs_events',{jobId:job.jobId,afterSeq:0});record.elapsedMs=Date.now()-started;
 if(job.state==='completed'){const manifest=await call('artifacts_inspect',{jobId:job.jobId});record.quality=manifest.quality;record.assets=manifest.assets.map(a=>({kind:a.kind,bytes:a.bytes,sha256:a.sha256}));}
 console.log(JSON.stringify({phase,state:job.state,jobId:job.jobId,elapsedMs:record.elapsedMs}));
 assert.equal(job.state,'completed',JSON.stringify(record));
}
try{
 credential('seed');seeded=true;writeFileSync(configPath,JSON.stringify({identityOrigin:origin,gatewayOrigin:origin}));configurationWritten=true;
 const status=await call('auth_status');assert.equal(status.userId,fixture.user_id);
 report.before=await call('network_get');assert.equal(report.before.settings.mode,'auto');assert.equal(report.before.source,'Windows 系统代理');
 assert(!existsSync(networkPath));await download('before-saving-auto',26983);assert(!existsSync(networkPath),'Download must not require saving settings');
 report.probe=await call('network_test',{settings:{mode:'auto',manualUrl:null}});assert(!existsSync(networkPath),'Testing must not persist settings');
 report.after=await call('network_set',{settings:{mode:'auto',manualUrl:null}});await download('after-saving-auto',26984);
 report.background=await call('background_status');report.passed=true;
}catch(error){report.error=String(error);throw error;}
finally{
 report.finishedAt=new Date().toISOString();
 if(configurationWritten){if(previousConfig)writeFileSync(configPath,previousConfig);else unlinkSync(configPath);}
 if(existsSync(networkPath))unlinkSync(networkPath);
 if(seeded)credential('delete');report.settingsRestored=true;
 writeFileSync(join(output,batch?'batch-acceptance.json':'acceptance.json'),JSON.stringify(report,null,2));
 await p.goto('http://127.0.0.1:1426/').catch(()=>{});await b.close();
}
