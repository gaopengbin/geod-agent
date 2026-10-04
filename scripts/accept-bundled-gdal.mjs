/** Actual native data import/export with only the app-local Python runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
const[modulePath,output]=process.argv.slice(2),{chromium}=await import(modulePath);
await fs.mkdir(output,{recursive:true});
const report={pass:false,cases:[]},runtime=path.resolve('apps/geod-agent-desktop/src-tauri/resources/gdal'),relocated=path.join(path.resolve(output),'relocated-gis');
await fs.cp(runtime,relocated,{recursive:true,filter:file=>!file.includes('__pycache__')});
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','TEMP','TMP','APPDATA','LOCALAPPDATA','USERPROFILE'].includes(key.toUpperCase())));
environment.PATH=path.join(process.env.SYSTEMROOT,'System32');environment.PYTHONHOME='C:\\no-system-python';environment.PYTHONPATH='C:\\no-user-site';
const fixture=path.join(path.resolve(output),'boundary.gpkg'),source=path.join(path.resolve(output),'boundary.geojson');
const geo={type:'FeatureCollection',features:[{type:'Feature',id:41,properties:{name:'实际内置运行环境',value:7},geometry:{type:'Polygon',coordinates:[[[116.1,39.6],[116.3,39.6],[116.3,39.8],[116.1,39.8],[116.1,39.6]]]}}]};await fs.writeFile(source,JSON.stringify(geo));
const script=`import sys,json,geopandas,pyogrio,rasterio,pyproj\nfrom pathlib import Path\nroot=Path(sys.executable).parent.resolve()\nassert Path(sys.prefix).resolve()==root\nassert all(Path(p).resolve().is_relative_to(root) for p in sys.path)\nf=geopandas.read_file(${JSON.stringify(source)})\nf.to_file(${JSON.stringify(fixture)},driver='GPKG',layer='range')\nprint(json.dumps({'prefix':str(root),'gdal':pyogrio.__gdal_version__,'rows':len(f)}))`;
const local=spawnSync(path.join(relocated,'python.exe'),['-I','-X','utf8','-c',script],{env:environment,encoding:'utf8',windowsHide:true});assert.equal(local.status,0,local.stderr);report.cases.push({name:'Relocated embedded Python reads and writes real GPKG without PATH, uv or system Python',pass:true,result:JSON.parse(local.stdout)});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw new Error(JSON.stringify(r.error));return r.value;};
const conversationId=`bundled-gdal-${crypto.randomUUID()}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/geo+json'});res.end(JSON.stringify(geo));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
  await rpc('workspace_set',{conversationId,directory:path.resolve(output),permission:'fullAccess'});
  const read=await rpc('data_input_read',{conversationId,request:{files:[{name:'boundary.gpkg',base64:(await fs.readFile(fixture)).toString('base64')}]}});assert.equal(read.boundary.polygonCount,1);assert.deepEqual(read.boundary.bounds,[116.1,39.6,116.3,39.8]);report.cases.push({name:'Actual native GPKG import uses bundled GDAL worker',pass:true,bounds:read.boundary.bounds});
  let task=await rpc('data_download_plan',{conversationId,title:'内置运行环境在线导出',idempotencyKey:crypto.randomUUID(),request:{kind:'online',spec:{sourceUrl:`http://127.0.0.1:${server.address().port}/boundary.geojson`,maxFeatures:10,pageSize:5,outputs:['geojson','gpkg']}}});
  await rpc('data_download_start_auto',{conversationId,taskId:task.id,planHash:task.planHash});
  for(let i=0;i<240;i++){task=await rpc('data_download_get',{conversationId,taskId:task.id});if(['completed','failed','cancelled'].includes(task.status))break;await sleep(300);}
  assert.equal(task.status,'completed',JSON.stringify(task));await rpc('data_download_inspect',{conversationId,taskId:task.id});report.cases.push({name:'Independent native background exports and verifies actual GeoJSON/GPKG with bundled Python',pass:true,task});
  const overview=await rpc('extensions_list'),gdal=overview.connectors.find(c=>c.transport==='gdalStdio');assert(gdal,'Existing builtin GDAL connector');
  const list=await rpc('mcp_tools',{id:gdal.id,conversationId});assert(list.tools.some(t=>t.name==='vector_info'));const result=await rpc('mcp_call',{id:gdal.id,conversationId,toolName:'vector_info',arguments:{uri:'boundary.gpkg'},executionId:crypto.randomUUID()});assert(!result.isError,JSON.stringify(result));report.cases.push({name:'Actual builtin GDAL MCP starts from the relocatable runtime and reads a GPKG',pass:true,tool:'vector_info',result});report.pass=true;
}catch(error){report.error=String(error);process.exitCode=1;}finally{await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,error:report.error}));}
