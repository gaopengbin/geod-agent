/** Live public ArcGIS/OGC datasets through the native background download path. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(r=>setTimeout(r,100));}
if(!page)throw new Error('Actual desktop page unavailable');await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw r.error;return r.value;};
const conversationId=`online-public-${crypto.randomUUID()}`,report={pass:false,cases:[]};
let originalNetwork;
await fs.mkdir(evidencePath,{recursive:true});
try{
  if(process.argv[4]==='--direct'){
    const background=await rpc('background_status');if(background.activeDownloads||background.activeAiTurns||background.maintenanceActive)throw new Error('Temporary network test requires idle companion');
    originalNetwork=(await rpc('network_get')).settings;await rpc('network_set',{settings:{mode:'direct',manualUrl:originalNetwork.manualUrl}});report.networkMode='temporary direct; original restored in finally';
  }
  await rpc('workspace_set',{conversationId,directory:path.resolve(evidencePath),permission:'fullAccess'});
  for(const [name,url,expected]of [['Actual ArcGIS Census states',"https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/3/query?where=STATE_NAME%20IN%20(%27Colorado%27,%27Utah%27)",2],['Actual OGC pygeoapi lakes','https://demo.pygeoapi.io/master/collections/lakes/items',null]]){
    let task=await rpc('data_download_plan',{conversationId,title:name,idempotencyKey:crypto.randomUUID(),request:{kind:'online',spec:{sourceUrl:url,maxFeatures:100,pageSize:5,outputs:['geojson','gpkg']}}});
    await rpc('data_download_start_auto',{conversationId,taskId:task.id,planHash:task.planHash});
    for(let i=0;i<240;i++){task=await rpc('data_download_get',{conversationId,taskId:task.id});if(['completed','failed','cancelled'].includes(task.status))break;await new Promise(r=>setTimeout(r,500));}
    if(task.status!=='completed')throw new Error(`${name}: ${task.error??task.status}`);
    const actual=JSON.parse(await fs.readFile(path.join(task.outputDir,'features.geojson'),'utf8'));
    if((expected!==null&&actual.features.length!==expected)||actual.features.length!==task.manifest.featureCount)throw new Error(`${name}: feature count mismatch`);
    if(name.includes('ArcGIS')&&(!actual.features.every(f=>Number.isInteger(f.id)&&f.properties.OBJECTID===f.id)||!actual.features.every(f=>['Colorado','Utah'].includes(f.properties.STATE_NAME))))throw new Error('ArcGIS original object IDs and attributes were not retained');
    if(name.includes('OGC')&&!actual.features.every(f=>f.id!==undefined&&Object.keys(f.properties).length>0))throw new Error('OGC source feature ID or properties lost');
    await rpc('data_download_inspect',{conversationId,taskId:task.id});report.cases.push({name,pass:true,task});console.log(`${name} PASS`);
  }
  report.pass=true;
}catch(error){report.cases.push({name:'actual public export',pass:false,error:String(error.message??error)});}
finally{if(originalNetwork){await rpc('network_set',{settings:originalNetwork});report.networkRestored=JSON.stringify((await rpc('network_get')).settings)===JSON.stringify(originalNetwork);if(!report.networkRestored)report.pass=false;}report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidencePath,'public-acceptance.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.map(c=>({name:c.name,pass:c.pass,error:c.error}))}));if(!report.pass)process.exitCode=1;
