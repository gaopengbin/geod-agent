/** Real desktop acceptance. Supply a development Playwright module, never a product dependency. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [mode, playwrightModule, evidencePath] = process.argv.slice(2);
if (!playwrightModule || !evidencePath) throw new Error('Usage: prepare|reopen <playwright module URL> <evidence folder>');
const {chromium} = await import(playwrightModule);
await fs.mkdir(evidencePath, {recursive:true});
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
if (!page) throw new Error('No actual desktop WebView');
const rpc = (command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const save = value=>fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(value,null,2));
try {
  if (mode==='prepare') {
    const conversationId=`background-accept-${crypto.randomUUID()}`;
    const directory=path.join(evidencePath,conversationId);
    await fs.mkdir(directory,{recursive:true});
    await rpc('workspace_set',{conversationId,directory,permission:'fullAccess'});
    const background=await rpc('background_status');
    const spec={schemaVersion:'0.1',kind:'imagery',sourceId:'esri-world-imagery',bounds:[136.83,35.21,136.89,35.25],zoomLevels:[16],outputFormats:['geotiff'],outputDirectory:path.join(directory,'nagoya-imagery'),limits:{maxTiles:10000,maxDecodedRgbaBytes:1073741824},exportOptions:{compression:'lzw',buildPyramid:false,generateSidecars:false,jpegQuality:90}};
    const plan=await rpc('plans_create',{conversationId,spec,toolExecutionId:`${conversationId}-plan`});
    const due=new Date(Date.now()+15000).toISOString();
    const schedule=await rpc('schedules_create',{conversationId,planId:plan.planId,name:'关窗影像验收',nextRunAt:due,repeatSeconds:null,maxRetries:0,executionId:`${conversationId}-schedule`});
    const task=await rpc('data_download_plan',{conversationId,title:'关窗矢量验收',idempotencyKey:`${conversationId}-vector`,request:{kind:'vector',spec:{source:{type:'mvt',id:'maplibre-demo-countries',name:'MapLibre 国家矢量',urlTemplate:'https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf',scheme:'xyz',layers:[]},bounds:[13.404,52.52,13.406,52.522],zoomLevels:[2],outputs:['geojson','gpkg']}}});
    const vectorSchedule=await rpc('data_schedules_create',{conversationId,taskId:task.id,name:'关窗矢量定时验收',nextRunAt:due,repeatSeconds:null,executionId:`${conversationId}-vector-schedule`});
    const job=await rpc('jobs_start_auto',{conversationId,planId:plan.planId,idempotencyKey:`${conversationId}-job`});
    const result={conversationId,directory,background,planId:plan.planId,job,schedule,vectorTask:task.id,vectorSchedule,startedAt:new Date().toISOString()};
    await save(result);
    console.log('Native download started:',JSON.stringify(job));
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      const current=await rpc('jobs_get',{jobId:job.jobId});
      const active=await rpc('jobs_active');
      if(active.includes(job.jobId)){
        const events=await rpc('jobs_events',{jobId:job.jobId,afterSeq:0});
        if(events.some(value=>JSON.stringify(value).includes('download'))){ result.beforeClose={current,events,background:await rpc('background_status')}; break; }
      }
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(!result.beforeClose) throw new Error('Could not observe an active download before closing');
    result.closedAt=new Date().toISOString();
    await save(result);
    // Close the real desktop window through its native API, not the debugging browser.
    await rpc('plugin:window|close',{label:'main'}).catch(()=>{});
    console.log(JSON.stringify({closed:true,backendPid:background.pid,jobId:job.jobId,due}));
  } else if(mode==='reopen') {
    const result=JSON.parse(await fs.readFile(path.join(evidencePath,'acceptance.json'),'utf8'));
    const status=await rpc('background_status');
    if(status.pid!==result.background.pid) throw new Error('Reopening spawned a different background');
    const job=await rpc('jobs_get',{jobId:result.job.jobId});
    const schedules=await rpc('schedules_runs',{conversationId:result.conversationId});
    const data=await rpc('data_schedules_runs',{conversationId:result.conversationId});
    result.afterReopen={at:new Date().toISOString(),status,job,schedules,data};
    if(job.state==='completed') result.afterReopen.artifacts=await rpc('artifacts_inspect',{jobId:job.jobId});
    await save(result);
    console.log(JSON.stringify(result.afterReopen));
  } else throw new Error('Unknown acceptance stage');
} finally {await browser.close();}
