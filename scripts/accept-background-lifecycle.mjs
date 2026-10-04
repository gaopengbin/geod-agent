/** Actual native worker lifecycle against an explicitly declared local tile service. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const [playwrightModule,evidencePath]=process.argv.slice(2);
if(!playwrightModule||!path.isAbsolute(evidencePath))throw new Error('Use a Playwright module and absolute evidence folder');
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
const desktop=path.resolve('apps/geod-agent-desktop');
const executable=path.join(desktop,'src-tauri/target/debug/geod-agent-desktop.exe');
const endpointFile=path.join(process.env.APPDATA,'dev.geod-agent.desktop/background-endpoint.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const crc32=bytes=>{let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;};
const chunk=(kind,bytes)=>{const type=Buffer.from(kind),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([length,type,bytes,crc]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(256,0);ihdr.writeUInt32BE(256,4);ihdr[8]=8;ihdr[9]=6;
const pixels=Buffer.alloc(256*1025);for(let y=0;y<256;y++)for(let x=0;x<256;x++){const i=y*1025+1+x*4;pixels[i]=x;pixels[i+1]=y;pixels[i+2]=180;pixels[i+3]=255;}
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
let delay=1500;const hits=new Map();
const fixture=http.createServer(async(req,res)=>{
  if(!/^\/tiles\/\d+\/\d+\/\d+\.png$/.test(req.url)){res.writeHead(404).end();return;}
  hits.set(req.url,(hits.get(req.url)??0)+1);await sleep(delay);
  if(res.destroyed)return;
  res.writeHead(200,{'content-type':'image/png','content-length':png.length});res.end(png);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${fixture.address().port}`;
let browser,page,originalEndpoint,protocolMutated=false;const created=[];
const report={startedAt:new Date().toISOString(),declaredFixture:'Local HTTP delayed PNG tiles; actual native downloader and ledger',cases:[]};
const save=()=>fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));
const connect=async()=>{
  for(let i=0;i<100;i++){
    try{browser=await chromium.connectOverCDP('http://127.0.0.1:9233');page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page){await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);return;}}catch{}
    if(browser)await browser.close().catch(()=>{});await sleep(200);
  }throw new Error('Actual development WebView unavailable');
};
const rpc=async(command,args={})=>{
  const value=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{error};}},{command,args});
  if(value.error)throw value.error;return value.value;
};
const probe=async(mode='security',command)=>JSON.parse((await exec('python',['-X','utf8','scripts/background-runtime-probe.py',mode,...(command?['--command',command]:[])],{windowsHide:true})).stdout);
const wait=async(check,description,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await sleep(100);}throw new Error('Timeout: '+description);};
const startDesktop=()=>exec('python',['-X','utf8','scripts/start-codex-dev.py','--local-gateway'],{windowsHide:true});
const closeDesktop=async()=>{await rpc('plugin:window|close',{label:'main'}).catch(()=>{});await browser.close().catch(()=>{});browser=null;await sleep(400);};
const background=()=>rpc('background_status');
const endpoint=async()=>JSON.parse(await fs.readFile(endpointFile,'utf8'));
const finishCase=async(name,result)=>{report.cases.push({name,pass:true,...result});await save();console.log(JSON.stringify({case:name,pass:true}));};
try{
  await connect();
  const initial=await background();assert.equal(initial.activeDownloads,0,'Existing work must be idle');assert.equal(initial.maintenanceActive,false);
  const security=await probe();assert.equal(security.valid.ok,true);assert.equal(security.valid.cacheControl,'no-store');
  for(const name of ['noAuth','wrongAuth','origin']){assert.equal(security[name].status,403);assert.equal(security[name].error.code,'BACKGROUND_AUTH');}
  assert.equal(security.unregistered.error.code,'BACKGROUND_COMMAND');
  for(const name of ['arrayArgs','extraField'])assert.equal(security[name].error.code,'BACKGROUND_INPUT');
  await finishCase('loopback-auth-and-command-boundaries',{results:security});
  const beforeDuplicate=await endpoint();
  const duplicate=spawn(executable,['--background-runtime'],{cwd:desktop,windowsHide:true,stdio:'ignore'});
  const duplicateCode=await new Promise(r=>duplicate.once('exit',r));assert.notEqual(duplicateCode,0);
  assert.deepEqual(await endpoint(),beforeDuplicate);assert.equal((await probe('rpc')).ok,true);
  await finishCase('single-instance',{pid:beforeDuplicate.pid,duplicateCode,endpointUnchanged:true});
  originalEndpoint=await fs.readFile(endpointFile,'utf8');
  await fs.writeFile(endpointFile,JSON.stringify({...JSON.parse(originalEndpoint),protocol:999}));protocolMutated=true;
  const startTime=Date.now();let versionError;try{await background();}catch(error){versionError=error;}
  await fs.writeFile(endpointFile,originalEndpoint);protocolMutated=false;
  assert.equal(versionError?.code,'BACKGROUND_VERSION');assert(Date.now()-startTime<4000);assert.equal((await background()).pid,beforeDuplicate.pid);
  await finishCase('protocol-version-error',{code:versionError.code,preciseError:true,pidUnchanged:true});
  const conversationId=`background-life-${crypto.randomUUID()}`,directory=path.join(evidencePath,conversationId);await fs.mkdir(directory,{recursive:true});
  await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});
  const sourceId=`background-life-${crypto.randomUUID()}`;
  await rpc('sources_save',{endpoint:{id:sourceId,name:'后台生命周期验收图源',urlTemplate:`${origin}/tiles/{z}/{x}/{y}.png`,scheme:'XYZ',tileSize:256,networkPolicy:'UserTrustedHttp',minIntervalMs:3000,attribution:'Declared local test fixture',license:''},minZoom:0,maxZoom:10,replaceExisting:false});
  const makeJob=async(name,bounds)=>{
    const spec={schemaVersion:'0.1',kind:'imagery',sourceId,bounds,zoomLevels:[5],outputFormats:['geotiff'],outputDirectory:path.join(directory,name),limits:{maxTiles:1000,maxDecodedRgbaBytes:1073741824},exportOptions:{compression:'lzw',buildPyramid:false,generateSidecars:false,jpegQuality:90}};
    const plan=await rpc('plans_create',{conversationId,spec,toolExecutionId:crypto.randomUUID()});
    const job=await rpc('jobs_start_auto',{conversationId,planId:plan.planId,idempotencyKey:crypto.randomUUID()});created.push(job.jobId);
    await wait(async()=>{const events=await rpc('jobs_events',{jobId:job.jobId,afterSeq:0});assert(!events.some(e=>e.state==='failed'),JSON.stringify(events));return events.some(e=>(e.completedTiles??0)>0)?events:null;},'actual tiles');
    return{plan,job};
  };
  const paused=await makeJob('pause-resume',[-90,-40,90,50]);
  let busy;try{await rpc('background_stop');}catch(error){busy=error;}
  assert.equal(busy?.code,'BACKGROUND_BUSY');await rpc('jobs_pause',{jobId:paused.job.jobId});
  const stop=await wait(async()=>{const job=await rpc('jobs_get',{jobId:paused.job.jobId});return job.state==='paused'&&!job.workerActive?job:null;},'pause settles');
  const events=await rpc('jobs_events',{jobId:paused.job.jobId,afterSeq:0}),retained=Math.max(...events.map(e=>e.completedTiles??0));assert(retained>0);
  const pid=(await background()).pid;await closeDesktop();await startDesktop();await connect();
  assert.equal((await background()).pid,pid);assert.equal((await rpc('jobs_get',{jobId:paused.job.jobId})).state,'paused');
  const resumed=await rpc('jobs_resume',{jobId:paused.job.jobId});assert.equal(resumed.jobId,paused.job.jobId);delay=30;
  const completed=await wait(async()=>{const job=await rpc('jobs_get',{jobId:resumed.jobId});assert(!['failed','partial'].includes(job.state),JSON.stringify(job));return job.state==='completed'?job:null;},'resume completed',120000);
  const artifacts=await rpc('artifacts_inspect',{jobId:resumed.jobId});assert.equal(artifacts.quality.missingTiles,0);assert.equal(artifacts.quality.status,'complete');
  await finishCase('pause-reopen-resume',{pid,jobId:resumed.jobId,retainedTiles:retained,totalTiles:paused.plan.plan.totalTiles,quality:artifacts.quality,busyStopCode:busy.code});
  delay=1500;
  const cancelled=await makeJob('cancel',[-170,0,-100,70]);await rpc('jobs_cancel',{jobId:cancelled.job.jobId});
  const cancelledJob=await wait(async()=>{const job=await rpc('jobs_get',{jobId:cancelled.job.jobId});return job.state==='cancelled'&&!job.workerActive?job:null;},'cancel settles');
  assert.equal((await background()).activeDownloads,0);await finishCase('cancel',{jobId:cancelledJob.jobId,state:cancelledJob.state});
  const crash=await makeJob('crash-resume',[95,-60,165,25]);const oldPid=(await background()).pid;
  await exec('taskkill.exe',['/PID',String(oldPid),'/F'],{windowsHide:true});
  const recoveredStatus=await background();assert.notEqual(recoveredStatus.pid,oldPid);assert.equal(recoveredStatus.activeDownloads,0);
  const interrupted=await rpc('jobs_get',{jobId:crash.job.jobId});assert(!(await rpc('jobs_active')).includes(crash.job.jobId));assert(!['completed','failed','cancelled'].includes(interrupted.state));
  await rpc('jobs_resume',{jobId:crash.job.jobId});delay=30;
  await wait(async()=>{const job=await rpc('jobs_get',{jobId:crash.job.jobId});assert(!['failed','partial'].includes(job.state),JSON.stringify(job));return job.state==='completed'?job:null;},'crash resume completed',120000);
  const recoveredArtifacts=await rpc('artifacts_inspect',{jobId:crash.job.jobId});assert.equal(recoveredArtifacts.quality.missingTiles,0);
  await finishCase('unexpected-exit-reconnect-resume',{oldPid,newPid:recoveredStatus.pid,jobId:crash.job.jobId,stateBeforeResume:interrupted.state,quality:recoveredArtifacts.quality});
  await rpc('background_stop');await sleep(300);assert.equal((await background()).running,false);await sleep(500);assert.equal((await background()).running,false);
  const restarted=await rpc('background_start');assert.equal(restarted.activeDownloads,0);
  await finishCase('explicit-stop-and-restart',{runningAfterStop:false,restartedPid:restarted.pid,noPollingRestart:true});
  report.pass=true;report.finishedAt=new Date().toISOString();report.fixtureRequests=hits.size;await save();
}catch(error){report.pass=false;report.failure=String(error.stack??JSON.stringify(error));await save();throw error;}
finally{
  if(protocolMutated&&originalEndpoint)await fs.writeFile(endpointFile,originalEndpoint);
  if(page&&!page.isClosed())for(const jobId of created)await rpc('jobs_cancel',{jobId}).catch(()=>{});
  if(browser)await browser.close().catch(()=>{});fixture.closeAllConnections();await new Promise(r=>fixture.close(r));
}
