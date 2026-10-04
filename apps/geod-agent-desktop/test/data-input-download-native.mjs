// Actual input conversion -> saved range -> plan -> Esri download -> verified GeoTIFF.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const fixture=join(tmpdir(),'geod-data-input-fixtures'),workspace=join(tmpdir(),`geod-input-download-${randomUUID()}`),conversationId=randomUUID();
mkdirSync(workspace,{recursive:true});await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const file=name=>({name,base64:readFileSync(join(fixture,name)).toString('base64')});
const cases=['geojson','gpkg','sqlite','kml','gml','fgb','kmz','wkt'].map(ext=>({name:ext,request:{files:[file('boundary.'+ext)]}}));
cases.push({name:'Shapefile group',request:{files:['shp','shx','dbf','prj','cpg'].map(ext=>file('boundary.'+ext))}},{name:'Shapefile ZIP',request:{files:[file('shapefile.zip')]}},{name:'CSV WKT',request:{files:[file('boundary.csv')],sourceCrs:'EPSG:4326'}});
const server=createServer((req,res)=>{res.setHeader('content-type','application/geo+json');res.end(readFileSync(join(fixture,'boundary.geojson')));});await new Promise(resolve=>server.listen(15440,'127.0.0.1',resolve));
cases.push({name:'Online GeoJSON',request:{url:'http://127.0.0.1:15440/boundary.geojson'}});
let connectionId;const report=[];
try{
 const draft=JSON.parse(readFileSync('../../infra/postgis-test/.secrets/reader-connection.json','utf8'));
 writeFileSync(join(workspace,'connection.json'),JSON.stringify(draft));
 const connected=await rpc('test_data_tool',{conversationId,tool:'data_connection_connect',arguments:{credentialFile:'connection.json',name:'下载链路实测'}});
 assert(connected.result.connection,JSON.stringify(connected.result));connectionId=connected.result.connection.id;
 assert(connected.result.layers.some(layer=>layer.name==='demo.boundaries_3857.geom'));
 assert(!JSON.stringify(connected).includes(draft.password));
 cases.push({name:'PostGIS EPSG:3857 through pgEdge MCP',request:{connectionId,layer:'demo.boundaries_3857.geom'}});
 for(const [i,test] of cases.entries()){
  let input=await rpc('data_input_read',{conversationId,request:test.request});
  assert(input.boundary,test.name+': '+JSON.stringify(input));
  const saved=await rpc('boundaries_save',{conversationId,boundary:input.boundary});
  assert.equal(saved.geometry.polygons.length,1);assert.equal(saved.geometry.polygons[0].length,2,'Hole retained');
  assert(saved.bounds.every((value,index)=>Math.abs(value-[116.1,39.6,116.3,39.8][index])<1e-6));
  const planned=await rpc('test_imagery_plan',{conversationId,executionId:`input-download:${conversationId}:${i}`,batch:false,arguments:{sourceId:'esri-world-imagery',boundaryId:saved.boundaryId,zoom:10,outputFormats:['geotiff']}});
  assert.equal(planned.errors.length,0);const plan=planned.plans[0].stored;
  const job=await rpc('jobs_start_auto',{conversationId,planId:plan.planId,idempotencyKey:`input-download:${conversationId}:${i}`});
  report.push({case:test.name,boundaryId:saved.boundaryId,sourceCrs:input.sourceCrs,planId:plan.planId,jobId:job.jobId,totalTiles:plan.plan.totalTiles});
 }
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){const states=await Promise.all(report.map(item=>rpc('jobs_get',{jobId:item.jobId})));assert(states.every(job=>!['failed','partial','cancelled'].includes(job.state)),JSON.stringify(states));if(states.every(job=>job.state==='completed'))break;await new Promise(resolve=>setTimeout(resolve,500));}
 for(const item of report){assert.equal((await rpc('jobs_get',{jobId:item.jobId})).state,'completed');const manifest=await rpc('artifacts_inspect',{jobId:item.jobId}),raster=await rpc('test_native_raster',{jobId:item.jobId});assert.equal(manifest.quality.status,'complete');assert.equal(manifest.quality.missingTiles,0);assert(raster.dataTile.nonzeroValues>0);Object.assign(item,{pass:true,quality:manifest.quality,assets:manifest.assets.map(({id,bytes,sha256})=>({id,bytes,sha256})),raster});console.log(item.case,'PASS',item.totalTiles,'tiles');}
}finally{server.close();if(connectionId)await rpc('data_connection_remove',{connectionId});writeFileSync('../../docs/implementation/evidence/data-input-download-native-2026-10-02.json',JSON.stringify({conversationId,workspace,cases:report},null,2));}
assert.equal(report.length,13);
