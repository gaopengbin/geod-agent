/** Actual desktop IPC/background ledger, GeoServer, and labelled private auth fixture. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {isDeepStrictEqual} from 'node:util';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(r=>setTimeout(r,100));}
if(!page)throw new Error('Actual desktop unavailable');
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw r.error;return r.value;};
const assert=(v,m)=>{if(!v)throw new Error(m);};
const report={pass:false,conversationId:`online-export-${crypto.randomUUID()}`,cases:[]};
const token=crypto.randomUUID(),connections=[],hits=[];
const features=[
  {type:'Feature',id:'point-1',properties:{fid:51,'名称':'测点甲',enabled:true,nullable:null,nested:{array:[1,'乙']},geometry:'original property'},geometry:{type:'Point',coordinates:[116.2,39.7]}},
  {type:'Feature',id:2,properties:{fid:52,'名称':'道路乙',enabled:null,nullable:12,nested:[1,2],geometry:'line property'},geometry:{type:'LineString',coordinates:[[116.2,39.7],[116.25,39.75]]}},
  {type:'Feature',id:'area-3',properties:{fid:53,'名称':'范围丙',enabled:false,nullable:13,nested:null,geometry:'area property'},geometry:{type:'Polygon',coordinates:[[[116.1,39.6],[116.3,39.6],[116.3,39.8],[116.1,39.8],[116.1,39.6]],[[116.15,39.65],[116.15,39.67],[116.17,39.67],[116.17,39.65],[116.15,39.65]]]}}
];
const fixture=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  const authenticated=req.headers.authorization===`Bearer ${token}`&&u.searchParams.get('token')===token;
  hits.push({path:u.pathname,authenticated});res.setHeader('content-type','application/json');
  if(!authenticated){res.writeHead(401);res.end('{}');return;}
  const slow=u.searchParams.get('slow')==='1';
  const respond=()=>{
    if(u.pathname==='/collections'){res.end(JSON.stringify({collections:[{id:'mixed',title:'真实属性测试夹具'}]}));return;}
    const offset=Number(u.searchParams.get('offset')??0);
    res.end(JSON.stringify({type:'FeatureCollection',numberMatched:3,features:[features[offset]],links:offset<2?[{rel:'next',href:`/collections/mixed/items?offset=${offset+1}${slow?'&slow=1':''}`}]:[]}));
  };
  if(slow){const t=setTimeout(respond,20000);res.on('close',()=>clearTimeout(t));}else respond();
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${fixture.address().port}/collections`;
const wait=async task=>{for(let i=0;i<150;i++){task=await rpc('data_download_get',{conversationId:report.conversationId,taskId:task.id});if(['completed','failed','cancelled','interrupted'].includes(task.status))return task;await new Promise(r=>setTimeout(r,500));}throw new Error('Native export did not finish');};
const plan=async(spec,title)=>rpc('data_download_plan',{conversationId:report.conversationId,title,idempotencyKey:crypto.randomUUID(),request:{kind:'online',spec}});
const start=async task=>rpc('data_download_start_auto',{conversationId:report.conversationId,taskId:task.id,planHash:task.planHash});
const check=async(name,fn)=>{try{const value=await fn();report.cases.push({name,pass:true,value});console.log(`${name} PASS`);}catch(error){report.cases.push({name,pass:false,error});console.error(JSON.stringify({name,error}));}};
let mainTask;
try{
  await rpc('workspace_set',{conversationId:report.conversationId,directory:path.resolve(evidencePath),permission:'confirmEach'});
  const connection=await rpc('online_connection_save',{draft:{name:'私有在线导出验收夹具',url:`${base}?token=${token}`,headers:{Authorization:`Bearer ${token}`}}});connections.push(connection.id);
  await check('Saved private connection discovery and approval binding',async()=>{
    assert(!JSON.stringify(connection).includes(token),'Secret leaked in public metadata');
    const catalog=await rpc('online_services_discover',{connectionId:connection.id});assert(catalog.layers.some(l=>l.id==='mixed'||l.name==='mixed'),'Actual catalog missing');
    mainTask=await plan({onlineConnectionId:connection.id,layer:'mixed',maxFeatures:3,pageSize:1,outputs:['geojson','gpkg']},'私有混合矢量');
    assert(!JSON.stringify(mainTask).includes(token),'Secret leaked into task ledger');
    try{await start(mainTask);throw new Error('Missing approval accepted');}catch(error){assert(error.code==='APPROVAL_REQUIRED','Approval mode ignored');}
    await rpc('workspace_set',{conversationId:report.conversationId,directory:path.resolve(evidencePath),permission:'fullAccess'});
    return{catalog,taskId:mainTask.id};
  });
  await check('Actual private three-page GeoJSON/GPKG native download with mixed geometry and attributes',async()=>{
    mainTask=await wait(await start(mainTask));assert(mainTask.status==='completed',mainTask.error??`State ${mainTask.status}`);
    const actual=JSON.parse(await fs.readFile(path.join(mainTask.outputDir,'features.geojson'),'utf8'));
    assert(isDeepStrictEqual(actual.features,features),'Original geometry/attribute/feature IDs changed');
    assert(mainTask.manifest.featureCount===3&&mainTask.manifest.fields.includes('geometry')&&mainTask.manifest.geometryTypes.join(',')==='LineString,Point,Polygon','Native manifest incomplete');
    await rpc('data_download_inspect',{conversationId:report.conversationId,taskId:mainTask.id});
    const preview=await rpc('data_download_preview',{conversationId:report.conversationId,taskId:mainTask.id});assert(preview.kind==='vector'&&preview.featureCount===3&&!preview.truncated,'Vector preview unavailable');
    return{task:mainTask,preview};
  });
  await check('Native artifacts reject modified files and cross-conversation access',async()=>{
    const file=path.join(mainTask.outputDir,'features.geojson'),original=await fs.readFile(file);
    try{await fs.appendFile(file,'\n');try{await rpc('data_download_inspect',{conversationId:report.conversationId,taskId:mainTask.id});throw new Error('Changed file accepted');}catch(error){assert(error.code==='DATA_INSPECTION_FAILED','File checksum not enforced');}}finally{await fs.writeFile(file,original);}
    const other=`online-export-other-${crypto.randomUUID()}`;await rpc('workspace_set',{conversationId:other,directory:path.resolve(evidencePath),permission:'fullAccess'});
    try{await rpc('data_download_get',{conversationId:other,taskId:mainTask.id});throw new Error('Foreign task accepted');}catch(error){assert(error.code==='DATA_TASK_NOT_FOUND','Conversation ownership not enforced');}
    return{taskId:mainTask.id};
  });
  const wfs='http://127.0.0.1:18083/geoserver/wfs';
  for(const [name,query]of [['WFS 2.0 projected GeoJSON',{version:'2.0.0',srsName:'EPSG:3857',outputFormat:'application/json'}],['WFS 1.0 GML2',{version:'1.0.0',srsName:'EPSG:4326',outputFormat:'GML2'}],['WFS 1.1 GML3',{version:'1.1.0',srsName:'urn:ogc:def:crs:EPSG::4326',outputFormat:'text/xml; subtype=gml/3.1.1'}],['WFS 2.0 GML3.2',{version:'2.0.0',srsName:'urn:ogc:def:crs:EPSG::4326',outputFormat:'application/gml+xml; version=3.2'}]]){
    await check(`${name} actual GeoServer paged export`,async()=>{
      const u=new URL(wfs);for(const[k,v]of Object.entries({...query,service:'WFS',CQL_FILTER:'id <= 3',sortBy:'id'}))u.searchParams.set(k,v);
      const task=await wait(await start(await plan({sourceUrl:u.href,layer:'geod:many_regions',maxFeatures:3,pageSize:1,outputs:['geojson','gpkg']},`${name} 图层`)));
      assert(task.status==='completed',task.error??task.status);
      const actual=JSON.parse(await fs.readFile(path.join(task.outputDir,'features.geojson'),'utf8'));
      assert(actual.features.length===3&&actual.features.every(f=>f.geometry.type==='Polygon'&&f.geometry.coordinates.length===2),'Actual GML/WFS features or holes lost');
      assert(task.manifest.bounds.every((v,i)=>Math.abs(v-[116.1,39.6,116.3,39.8][i])<1e-6),'Actual WFS CRS axes wrong');
      await rpc('data_download_inspect',{conversationId:report.conversationId,taskId:task.id});return task;
    });
  }
  await check('Cached WFS input retains actual remote layer identity',async()=>{
    const first=await rpc('data_input_read',{conversationId:report.conversationId,request:{url:wfs,layer:'geod:boundary',pageSize:1,maxFeatures:1}});
    const second=await rpc('data_input_read',{conversationId:report.conversationId,request:{handle:first.handle,layer:'geod:boundary'}});
    assert(second.selectedLayer==='geod:boundary'&&JSON.stringify(second.boundary.bounds)===JSON.stringify(first.boundary.bounds),'Cached source identity changed');
    try{await rpc('data_input_read',{conversationId:report.conversationId,request:{handle:first.handle,layer:'geod:regions'}});throw new Error('Wrong cached layer accepted');}catch(error){assert(error.code==='INPUT_LAYER_NOT_FOUND','Cached service layer not validated');}
    return{handle:first.handle,selectedLayer:second.selectedLayer,bounds:second.boundary.bounds};
  });
  await check('Removed private connection prevents a pending download',async()=>{
    const c=await rpc('online_connection_save',{draft:{name:'移除连接测试夹具',url:`${base}?token=${token}`,headers:{Authorization:`Bearer ${token}`}}});
    const task=await plan({onlineConnectionId:c.id,layer:'mixed',outputs:['geojson']},'移除连接的任务');await rpc('online_connection_remove',{connectionId:c.id});
    try{await start(task);throw new Error('Removed secret used');}catch(error){assert(error.code==='INPUT_CONNECTION_NOT_FOUND','Removed connection accepted');}
    await rpc('data_download_discard',{conversationId:report.conversationId,taskId:task.id});return{taskId:task.id};
  });
  await check('Actual active HTTP export cancels without committing output',async()=>{
    const c=await rpc('online_connection_save',{draft:{name:'延迟取消测试夹具',url:`${base}/mixed/items?slow=1&token=${token}`,headers:{Authorization:`Bearer ${token}`}}});connections.push(c.id);
    let task=await start(await plan({onlineConnectionId:c.id,outputs:['geojson']},'在线导出取消测试'));
    for(let i=0;i<40;i++){task=await rpc('data_download_get',{conversationId:report.conversationId,taskId:task.id});if(task.status==='downloading')break;await new Promise(r=>setTimeout(r,100));}
    assert(task.status==='downloading','Actual background HTTP did not start');
    await rpc('data_download_cancel',{conversationId:report.conversationId,taskId:task.id});task=await wait(task);
    assert(task.status==='cancelled','Export cancellation failed');
    assert(!(await fs.stat(task.outputDir).catch(()=>null)),'Cancelled output committed');return{taskId:task.id,status:task.status};
  });
  assert(hits.length>3&&hits.every(h=>h.authenticated),'Saved private authentication not applied');
  report.authenticatedRequests=hits;report.pass=report.cases.every(c=>c.pass);
}catch(error){report.cases.push({name:'native export setup',pass:false,error});}
finally{for(const id of connections)await rpc('online_connection_remove',{connectionId:id}).catch(()=>{});report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();fixture.closeAllConnections();fixture.close();}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,failed:report.cases.filter(c=>!c.pass).map(c=>c.name)}));if(!report.pass)process.exitCode=1;
